
import { path } from './path_api';
import { getStorage } from './storage';
import * as client from './bitshares_client';
const { BitShares, waitForConnected } = client;
import * as chainOrders from './chain_orders';
import { blockchainToFloat, floatToBlockchainInt, resolveConfigValue } from './order/utils/math';
import { toFiniteNumber } from './order/format';
import { createBotKey } from './account_orders';
import * as fundRegistry from './fund_registry';
import { writeJsonFileAtomic } from './bots_file_lock';
import { FEE_PARAMETERS, DEFAULT_TARGET_CR, TIMING } from './constants';
import { roundToDecimals } from './order/utils/math';
import { PATHS } from './paths';
import { readJSON } from './utils/fs_utils';
import _sysUtils = require('./order/utils/system');
const { deriveLiquidityPoolTokenValue, ensureDir: ensureDirSync } = _sysUtils;
'use strict';

const storage = getStorage();
import {
    buildCollateralFallbackPlan,
    buildDebtFirstCrPlan,
    resolveMinCollateralIncreaseThreshold,
    resolveTargetCollateralRatio,
} from './cr_planner';
import { getErrorMessage } from './utils/errors';

const CREDIT_FEE_RATE_DENOM = 1_000_000;
const ZERO_ASSET_ID = '1.3.0';
const DEFAULT_STATE_DIR = PATHS.CREDIT_RUNTIME_DIR;
const GRAPHENE_COLLATERAL_RATIO_DENOM = FEE_PARAMETERS.GRAPHENE_COLLATERAL_RATIO_DENOM;


function deepClone(value: any): any {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function positiveOrNull(value: any): number | null {
    const num = toFiniteNumber(value, undefined);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeResolvedPriceResult(value: any, liveSource: any, missingSource: any): any {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const price = positiveOrNull(value.price);
        return {
            price,
            source: price !== null
                ? (typeof value.source === 'string' && value.source ? value.source : liveSource)
                : missingSource,
        };
    }
    const price = positiveOrNull(value);
    return {
        price,
        source: price !== null ? liveSource : missingSource,
    };
}

function positiveOrPercentOrNull(value: any): number | null {
    const numeric = positiveOrNull(value);
    if (numeric !== null) return numeric;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent) && percent > 0 ? percent / 100 : null;
}

function normalizeNumberArray(value: any): string[] {
    return Array.isArray(value)
        ? value.map((item: any) => String(item)).filter(Boolean)
        : [];
}

function toGrapheneCollateralRatio(value: any): number | null {
    const numeric = positiveOrNull(value);
    if (numeric === null) return null;
    const scaled = Math.round(numeric * GRAPHENE_COLLATERAL_RATIO_DENOM);
    return Number.isInteger(scaled) && scaled > 0 && scaled <= 0xffff ? scaled : null;
}

function getMapEntries(value: any): any[] {
    if (value instanceof Map) return Array.from(value.entries());
    if (Array.isArray(value)) {
        if (value.length > 0 && typeof value[0] === 'object' && !Array.isArray(value[0]) && value[0] !== null && 'key' in value[0] && 'value' in value[0]) {
            return value.map((item: any) => [item.key, item.value]);
        }
        return value;
    }
    if (value && typeof value === 'object') return Object.entries(value);
    return [];
}

function getPriceQuoteAssetId(price: any): string | null {
    return price?.quote?.asset_id || null;
}

function toAmountObject(amount: any, assetId: any): any {
    return {
        amount,
        asset_id: assetId,
    };
}

function getChainAmountValue(value: any): number {
    if (value && typeof value === 'object' && value.amount !== undefined) {
        return toFiniteNumber(value.amount, undefined);
    }
    return toFiniteNumber(value, undefined);
}

function getAssetPrecision(asset: any): number | null {
    const precision = Number(asset?.precision);
    return Number.isFinite(precision) ? precision : null;
}

function blockchainAmountToFloat(value: any, asset: any): number | null {
    const amount = getChainAmountValue(value);
    const precision = getAssetPrecision(asset);
    if (!Number.isFinite(amount) || precision === null) {
        return null;
    }
    return blockchainToFloat(amount, precision);
}

function isDeterministicMpaDebtBalanceError(err: any, plan: any): boolean {
    const debtDelta = toFiniteNumber(plan?.debtDelta, 0);
    if (!Number.isFinite(debtDelta) || debtDelta >= 0) {
        return false;
    }
    const message = String(err?.message || err || '').toLowerCase();
    return message.includes('insufficient')
        && (message.includes('balance') || message.includes('fund') || message.includes('mpa'));
}

function isMaxBorrowAmountError(err: any): boolean {
    const message = String(err?.message || err || '');
    return /would exceed maxBorrowAmount/.test(message) || /exceeds maxBorrowAmountPerOperation/.test(message);
}

function normalizeCollateralMap(acceptableCollateral: any): Map<string, any> {
    const result = new Map();
    for (const [assetId, price] of getMapEntries(acceptableCollateral)) {
        if (!assetId || !price) continue;
        result.set(String(assetId), price);
    }
    return result;
}

function resolveAutoRepayValue(value: any): number {
    if (value === true) return 1;
    if (value === false || value === null || value === undefined) return 0;
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const int = Math.trunc(num);
    if (int < 0) return 0;
    if (int > 2) return 2;
    return int;
}

function normalizeAmountSpec(spec: any): any {
    if (spec === null || spec === undefined) return null;
    if (typeof spec === 'number' || typeof spec === 'string') {
        return { amount: spec, assetId: null };
    }
    if (typeof spec === 'object') {
        return {
            amount: spec.amount ?? spec.value ?? null,
            assetId: spec.asset_id || spec.assetId || spec.asset || null,
        };
    }
    return null;
}

function isPercentageAmountSpec(spec: any): boolean {
    const normalized = normalizeAmountSpec(spec);
    return typeof normalized?.amount === 'string' && normalized.amount.trim().endsWith('%');
}

function getAccountRef(bot: any): any {
    return bot?.accountId
        || bot?.account?.id
        || bot?.account?.name
        || bot?.config?.preferredAccount
        || null;
}

function getAccountName(bot: any): any {
    return bot?.account?.name
        || bot?.config?.preferredAccount
        || bot?.account?.id
        || bot?.accountId
        || null;
}

function snakeToCamel(method: any): string {
    return String(method || '').replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseFullAccount(fullAccountResult: any): any {
    if (!Array.isArray(fullAccountResult) || fullAccountResult.length === 0) return null;
    const entry = fullAccountResult[0];
    if (Array.isArray(entry) && entry.length >= 2) {
        return entry[1]?.account || entry[1] || null;
    }
    return entry?.account || entry || null;
}

function parseCallOrders(accountObj: any): any[] {
    if (!accountObj || typeof accountObj !== 'object') return [];
    if (Array.isArray(accountObj.call_orders)) return accountObj.call_orders;
    if (accountObj.account && Array.isArray(accountObj.account.call_orders)) return accountObj.account.call_orders;
    return [];
}

function parseDealSummary(deal: any): any {
    if (!deal || typeof deal !== 'object') return null;
    return {
        id: deal.id,
        borrower: deal.borrower,
        offerId: deal.offerId || deal.offer_id || null,
        offerOwner: deal.offerOwner || deal.offer_owner || null,
        debtAssetId: deal.debtAssetId || deal.debt_asset || null,
        debtAmount: toFiniteNumber(deal.debtAmount ?? deal.debt_amount, 0) || 0,
        collateralAssetId: deal.collateralAssetId || deal.collateral_asset || null,
        collateralAmount: toFiniteNumber(deal.collateralAmount ?? deal.collateral_amount, 0) || 0,
        feeRate: toFiniteNumber(deal.feeRate ?? deal.fee_rate, 0) || 0,
        latestRepayTime: deal.latestRepayTime || deal.latest_repay_time || null,
        autoRepay: toFiniteNumber(deal.autoRepay ?? deal.auto_repay, 0) || 0,
    };
}

function parseCallOrderSummary(order: any): any {
    if (!order || typeof order !== 'object') return null;
    return {
        id: order.id || null,
        borrower: order.borrower || null,
        debtAssetId: order.debtAssetId || order.call_price?.quote?.asset_id || null,
        debtAmount: toFiniteNumber(order.debt?.amount ?? order.debtAmount, 0) || 0,
        collateralAssetId: order.collateralAssetId || order.call_price?.base?.asset_id || null,
        collateralAmount: toFiniteNumber(order.collateral?.amount ?? order.collateralAmount, 0) || 0,
        debt: order.debt || null,
        collateral: order.collateral || null,
        call_price: order.call_price || null,
    };
}

function parseCreditOfferSummary(offer: any): any {
    if (!offer || typeof offer !== 'object') return null;
    return {
        id: offer.id || null,
        ownerAccount: offer.owner_account || offer.ownerAccount || null,
        assetType: offer.asset_type || offer.assetType || null,
        totalBalance: toFiniteNumber(offer.total_balance ?? offer.totalBalance, 0) || 0,
        currentBalance: toFiniteNumber(offer.current_balance ?? offer.currentBalance, 0) || 0,
        feeRate: toFiniteNumber(offer.fee_rate ?? offer.feeRate, 0) || 0,
        maxDurationSeconds: toFiniteNumber(offer.max_duration_seconds ?? offer.maxDurationSeconds, 0) || 0,
        minDealAmount: toFiniteNumber(offer.min_deal_amount ?? offer.minDealAmount, 0) || 0,
        enabled: !!offer.enabled,
        acceptableCollateral: offer.acceptable_collateral || offer.acceptableCollateral || null,
    };
}

class CreditRuntime {
    bot: any;
    config: any;
    options: any;
    log: any;
    warn: any;
    botKey: string;
    stateDir: string;
    statePath: string;
    _assetCache: Map<any, any>;
    _objectCache: Map<any, any>;
    _fullAccountCache: any;
    _borrowerDealsCache: any;
    state: any;
    _loaded: boolean;
    _maintenanceInFlight: boolean;
    _watchdogInFlight: boolean;
    _reborrowsInFlight: boolean;
    _splitInFlight: boolean;

    constructor(bot: any, options: any = {}) {
        this.bot = bot || {};
        this.config = this.bot.config || {};
        this.options = options || {};
        this.log = typeof this.bot._log === 'function' ? this.bot._log.bind(this.bot) : console.log.bind(console);
        this.warn = typeof this.bot._warn === 'function' ? this.bot._warn.bind(this.bot) : console.warn.bind(console);

        this.botKey = this.config.botKey
            || createBotKey(this.config, this.config.botIndex ?? 0);
        this.stateDir = this.options.stateDir || DEFAULT_STATE_DIR;
        this.statePath = path.join(this.stateDir, `${this.botKey}.json`);
        this._assetCache = new Map();
        this._objectCache = new Map();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        this.state = this._createDefaultState();
        this._loaded = false;
        this._maintenanceInFlight = false;
        this._watchdogInFlight = false;
        this._reborrowsInFlight = false;
        this._splitInFlight = false;
    }

    _createDefaultState() {
        return {
            botKey: this.botKey,
            updatedAt: null,
            mpaCallOrders: [],
            activeDealIds: [],
            activeOfferIds: [],
            ownedCreditOffers: [],
            creditDeals: [],
            debtSnapshot: null,
            lastBorrowRequest: null,
            lastRepayAt: null,
            lastGridResetAt: null,
            lastCrAdjustment: null,
            reborrowPending: false,
            pendingReborrows: [],
            positions: {}, // debtAssetId -> positionState
        };
    }

    get debtPolicy() {
        return this.config?.debtPolicy && typeof this.config.debtPolicy === 'object'
            ? this.config.debtPolicy
            : null;
    }

    isEnabled() {
        const dp = this.debtPolicy;
        if (!dp) return false;
        if (!Array.isArray(dp.lending) || dp.lending.length === 0) return false;
        return dp.lending.every((item: any) =>
            typeof item.collateralAsset === 'string' && item.collateralAsset.length > 0
        );
    }

    _positionKey(debtAssetId: any, collateralAssetId: any): string {
        return `${debtAssetId}:${collateralAssetId}`;
    }

    _findLendingItemByType(type: any): any {
        const dp = this.debtPolicy;
        if (!Array.isArray(dp?.lending)) return null;
        return dp.lending.find((item: any) => item.type === type) || null;
    }

    async _findLendingItemForAsset(assetId: any, typeFilter: any): Promise<any> {
        if (!assetId || !this.debtPolicy?.lending) return null;
        for (const item of (this.debtPolicy.lending as any[])) {
            if (typeFilter && item.type !== typeFilter) continue;
            let cached = this._assetCache.get(String(item.asset));
            if (!cached && item.asset) {
                cached = await this._resolveAsset(item.asset);
            }
            if (cached && String(cached.id) === String(assetId)) {
                return item;
            }
        }
        return null;
    }

    _stateWithDefaults(state: any = {}): any {
        const merged = { ...this._createDefaultState(), ...deepClone(state || {}) };
        merged.activeDealIds = Array.isArray(merged.activeDealIds) ? merged.activeDealIds : [];
        merged.activeOfferIds = Array.isArray(merged.activeOfferIds) ? merged.activeOfferIds : [];
        merged.mpaCallOrders = Array.isArray(merged.mpaCallOrders) ? merged.mpaCallOrders : [];
        merged.ownedCreditOffers = Array.isArray(merged.ownedCreditOffers) ? merged.ownedCreditOffers : [];
        merged.creditDeals = Array.isArray(merged.creditDeals) ? merged.creditDeals : [];
        merged.pendingReborrows = Array.isArray(merged.pendingReborrows) ? merged.pendingReborrows : [];
        merged.reborrowPending = merged.pendingReborrows.length > 0 || !!merged.reborrowPending;
        merged.botKey = merged.botKey || this.botKey;
        merged.positions = merged.positions && typeof merged.positions === 'object' ? merged.positions : {};
        return merged;
    }

    async loadState({ forceReload = false }: any = {}): Promise<any> {
        if (this._loaded && !forceReload) {
            return this.state;
        }

        ensureDirSync(this.stateDir);
        if (!storage.exists(this.statePath)) {
            this.state = this._stateWithDefaults();
            this._loaded = true;
            return this.state;
        }

        try {
            const parsed = readJSON(this.statePath);
            this.state = this._stateWithDefaults(parsed);
        } catch (err: any) {
            this.warn(`credit runtime: failed to load ${this.statePath}: ${getErrorMessage(err)}`);
            this.state = this._stateWithDefaults();
        }

        this._loaded = true;
        return this.state;
    }

    async persistState(reason: any = 'update'): Promise<any> {
        ensureDirSync(this.stateDir);
        this.state.updatedAt = new Date().toISOString();
        this.state.botKey = this.botKey;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A plain
        // writeFileSync here could leave a truncated state file on crash and
        // cause the next process startup to lose all credit/MPA tracking.
        writeJsonFileAtomic(this.statePath, this.state);
        if (reason) {
            this.log(`credit runtime: persisted ${this.botKey} state (${reason})`);
        }
        return this.state;
    }

    async shutdown(): Promise<void> {
        if (!this._loaded) return;
        await this.persistState('shutdown');
    }

    async _dbCall(method: any, args: any[] = []) {
        await waitForConnected();
        if (!BitShares?.db) {
            throw new Error('BitShares DB client is unavailable');
        }

        const camelMethod = snakeToCamel(method);
        if (camelMethod && typeof BitShares.db[camelMethod] === 'function') {
            return BitShares.db[camelMethod](...(Array.isArray(args) ? args : []));
        }

        if (typeof BitShares.db.call !== 'function') {
            throw new Error(`BitShares DB method is unavailable: ${method}`);
        }
        return BitShares.db.call(method, args);
    }

    async _resolveAccountId(accountRef: any): Promise<any> {
        if (!accountRef) return null;
        if (/^1\.2\.\d+$/.test(accountRef)) return accountRef;
        return chainOrders.resolveAccountId(accountRef);
    }

    async _resolveAccountName(accountRef: any): Promise<any> {
        if (!accountRef) return null;
        if (!/^1\.2\.\d+$/.test(accountRef)) return accountRef;
        return chainOrders.resolveAccountName(accountRef);
    }

    async _getFullAccount(accountRef: any): Promise<any> {
        if (!accountRef) return null;
        if (this._fullAccountCache && this._fullAccountCache.ref === String(accountRef)) {
            return this._fullAccountCache.account;
        }
        const accounts = await this._dbCall('get_full_accounts', [[accountRef], false]);
        const account = parseFullAccount(accounts);
        this._fullAccountCache = { ref: String(accountRef), account: account || null };
        return account || null;
    }

    async _resolveAsset(assetRef: any): Promise<any> {
        if (!assetRef) return null;
        const cacheKey = String(assetRef);
        if (this._assetCache.has(cacheKey)) {
            return this._assetCache.get(cacheKey);
        }

        let asset: any = null;
        if (/^1\.3\.\d+$/.test(cacheKey)) {
            const result = await this._dbCall('get_assets', [[cacheKey]]);
            asset = Array.isArray(result) ? result[0] : null;
        } else {
            const result = await this._dbCall('lookup_asset_symbols', [[cacheKey]]);
            asset = Array.isArray(result) ? result[0] : null;
        }

        if (asset) {
            this._assetCache.set(cacheKey, asset);
            if (asset.id) {
                this._assetCache.set(String(asset.id), asset);
            }
            if (asset.symbol) {
                this._assetCache.set(String(asset.symbol), asset);
            }
        }

        return asset;
    }

    async _resolveBitassetData(assetRef: any): Promise<any> {
        const asset = await this._resolveAsset(assetRef);
        const bitassetDataId = asset?.bitasset_data_id || null;
        if (!bitassetDataId) return null;

        if (this._objectCache.has(bitassetDataId)) {
            return this._objectCache.get(bitassetDataId);
        }

        const objects = await this._dbCall('get_objects', [[bitassetDataId]]);
        const bitassetData = Array.isArray(objects) ? objects[0] : null;
        if (bitassetData) {
            this._objectCache.set(bitassetDataId, bitassetData);
        }
        return bitassetData;
    }

    _computeBtsPerDebt(settlementPrice: any, debtAsset: any, backingAsset: any): number | null {
        const base = settlementPrice?.base;
        const quote = settlementPrice?.quote;
        if (!base || !quote || !debtAsset || !backingAsset) return null;

        const baseAsset = base.asset_id === debtAsset.id ? debtAsset : backingAsset;
        const quoteAsset = quote.asset_id === debtAsset.id ? debtAsset : backingAsset;
        const baseAmount = blockchainAmountToFloat(base.amount, baseAsset);
        const quoteAmount = blockchainAmountToFloat(quote.amount, quoteAsset);
        if (baseAmount == null || quoteAmount == null || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }

        if (base.asset_id === backingAsset.id && quote.asset_id === debtAsset.id) {
            return baseAmount / quoteAmount;
        }
        if (base.asset_id === debtAsset.id && quote.asset_id === backingAsset.id) {
            return quoteAmount / baseAmount;
        }
        return null;
    }

    _normalizePolicyList(value: any): string[] {
        return normalizeNumberArray(value);
    }

    _rebuildCreditTrackingFromPositions(): void {
        const allActiveDealIds: string[] = [];
        const allActiveOfferIds: string[] = [];
        const allCreditDeals: any[] = [];
        for (const pos of (Object.values(this.state.positions || {}) as any[])) {
            if (Array.isArray(pos.activeDealIds)) {
                allActiveDealIds.push(...pos.activeDealIds);
            }
            if (Array.isArray(pos.activeOfferIds)) {
                allActiveOfferIds.push(...pos.activeOfferIds);
            }
            if (Array.isArray(pos.creditDeals)) {
                allCreditDeals.push(...pos.creditDeals);
            }
        }
        this.state.activeDealIds = allActiveDealIds;
        this.state.activeOfferIds = allActiveOfferIds;
        this.state.creditDeals = allCreditDeals;
    }

    async _pruneCreditStateForPolicy(lendingItems: any[] = []) {
        const validCreditPositionKeys = new Set();
        for (const item of lendingItems) {
            if (item?.type !== 'creditOffer') continue;
            const debtAsset = await this._resolveAsset(item.asset);
            const collateralAsset = await this._resolveAsset(item.collateralAsset);
            if (debtAsset?.id && collateralAsset?.id) {
                validCreditPositionKeys.add(this._positionKey(String(debtAsset.id), String(collateralAsset.id)));
            }
        }

        for (const [key, pos] of (Object.entries(this.state.positions || {}) as Array<[string, any]>)) {
            if (validCreditPositionKeys.has(key)) continue;
            if (!pos || typeof pos !== 'object') continue;
            delete pos.creditDeals;
            delete pos.activeDealIds;
            delete pos.activeOfferIds;
            delete pos.creditConversionRate;
        }
    }

    async _resolveAmountToBlockchainInt(spec: any, asset: any, accountRef: any, { balanceField = 'total', referenceAmount = null, referenceLabel = 'available balance' }: any = {}): Promise<any> {
        const normalized = normalizeAmountSpec(spec);
        if (!normalized || normalized.amount === null || normalized.amount === undefined) {
            return null;
        }
        if (!asset || !asset.id) {
            throw new Error('Unable to resolve asset metadata for amount spec');
        }

        const isPercent = typeof normalized.amount === 'string' && normalized.amount.trim().endsWith('%');
        let total: number | null = null;
        if (isPercent) {
            if (Number.isFinite(referenceAmount)) {
                total = Number(referenceAmount);
            } else {
                if (!accountRef) {
                    throw new Error(`Unable to resolve account for percentage amount on ${asset.id}`);
                }
                const balances = await chainOrders.getOnChainAssetBalances(accountRef, [asset.id]);
                const balance = (balances as Record<string, any>)?.[String(asset.id)] || (balances as Record<string, any>)?.[String(asset.symbol)] || null;
                total = toFiniteNumber(balance?.[balanceField], undefined);
                if (!Number.isFinite(total) || total < 0) {
                    throw new Error(`Unable to resolve ${referenceLabel} for ${asset.id}`);
                }
            }
            if (!Number.isFinite(total) || total < 0) {
                throw new Error(`Unable to resolve account for percentage amount on ${asset.id}`);
            }
        }

        const resolved = resolveConfigValue(normalized.amount, total);
        if (!Number.isFinite(resolved) || resolved <= 0) {
            return null;
        }
        if (isPercent && total !== null && resolved > total) {
            throw new Error(`Requested amount ${resolved} exceeds available ${balanceField} balance ${total} for ${asset.id}`);
        }

        const intValue = floatToBlockchainInt(resolved, asset.precision);
        if (!Number.isFinite(intValue) || intValue <= 0) {
            return null;
        }

        return intValue;
    }

    async _resolveLendingPolicyForOffer(offer: any): Promise<any> {
        const offerDebtAssetId = offer?.asset_type || null;
        if (!offerDebtAssetId || !this.debtPolicy?.lending) return null;
        for (const item of this.debtPolicy.lending) {
            if (item.type !== 'creditOffer') continue;
            let cached = this._assetCache.get(String(item.asset));
            if (!cached && item.asset) {
                cached = await this._resolveAsset(item.asset);
            }
            if (cached && String(cached.id) === String(offerDebtAssetId)) {
                return item;
            }
        }
        return null;
    }

    /**
     * Resolve the MPA feed price for a given debt/collateral pair.
     * Uses cached value if fresh, otherwise fetches from the blockchain.
     * @param {string} debtAssetId - The debt asset ID
     * @param {string} collateralAssetId - The collateral asset ID
     * @param {Object} [options] - Optional settings
     * @param {boolean} [options.includeSource] - When true, returns { price, source } object
     * @returns {number|Object|null} Price number, { price, source } object, or null
     */
    async _resolveMpaFeedPrice(debtAssetId: any, collateralAssetId: any, options: { includeSource?: boolean } = {}): Promise<any> {
        if (!debtAssetId || !collateralAssetId) return null;

        const MPA_FEED_MAX_AGE_MS = require('./constants').TIMING.MPA_FEED_MAX_AGE_MS;
        const posKey = this._positionKey(debtAssetId, collateralAssetId);
        const cached = positiveOrNull(this.state.positions[posKey]?.mpaFeedPrice);
        const cachedAt = this.state.positions[posKey]?.mpaFeedPriceAt || 0;
        const cachedIsFresh = cached !== null && (Date.now() - cachedAt) < MPA_FEED_MAX_AGE_MS;

        const bitassetData = await this._resolveBitassetData(debtAssetId);
        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        if (!debtAsset || !collateralAsset) {
            if (options.includeSource) {
                return cachedIsFresh
                    ? { price: cached, source: 'cached-feed' }
                    : { price: null, source: 'missing-feed' };
            }
            return cachedIsFresh ? cached : null;
        }

        const feedPrice = this._computeBtsPerDebt(bitassetData?.current_feed?.settlement_price, debtAsset, collateralAsset);
        if (feedPrice != null && Number.isFinite(feedPrice) && feedPrice > 0) {
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].mpaFeedPrice = feedPrice;
            this.state.positions[posKey].mpaFeedPriceAt = Date.now();
            return options.includeSource ? { price: feedPrice, source: 'live-feed' } : feedPrice;
        }

        if (options.includeSource) {
            return cachedIsFresh
                ? { price: cached, source: 'cached-feed' }
                : { price: null, source: 'missing-feed' };
        }
        return cachedIsFresh ? cached : null;
    }

    /**
     * Resolve the credit conversion rate for a given lending item.
     * Uses cached value if fresh, otherwise derives from credit deals.
     * @param {Object} lendingItem - The lending item config
     * @param {string} debtAssetId - The debt asset ID
     * @param {string} collateralAssetId - The collateral asset ID
     * @param {Object} [options] - Optional settings
     * @param {boolean} [options.includeSource] - When true, returns { price, source } object
     * @returns {number|Object|null} Rate number, { price, source } object, or null
     */
    async _resolveCreditConversionRate(lendingItem: any, debtAssetId: any, collateralAssetId: any, options: { includeSource?: boolean } = {}): Promise<any> {
        if (!debtAssetId || !collateralAssetId) return null;

        const CREDIT_RATE_MAX_AGE_MS = require('./constants').TIMING.CREDIT_RATE_MAX_AGE_MS;
        const posKey = this._positionKey(debtAssetId, collateralAssetId);
        const cached = positiveOrNull(this.state.positions[posKey]?.creditConversionRate);
        const cachedAt = this.state.positions[posKey]?.creditConversionRateAt || 0;
        const cachedIsFresh = cached !== null && (Date.now() - cachedAt) < CREDIT_RATE_MAX_AGE_MS;

        const offerIds = new Set();

        const deals = Array.isArray(this.state.positions[posKey]?.creditDeals)
            ? this.state.positions[posKey].creditDeals
            : [];
        for (const deal of deals) {
            if (deal?.offerId) offerIds.add(String(deal.offerId));
        }

        const allowedOfferIds = this._normalizePolicyList(lendingItem?.allowedOfferIds);
        for (const id of allowedOfferIds) {
            if (id) offerIds.add(String(id));
        }

        if (offerIds.size === 0) {
            // Fallback: scan owned credit offers for pricing when no deal-based
            // or allowed offer IDs are configured.
            const ownedOffers = Array.isArray(this.state.ownedCreditOffers) ? this.state.ownedCreditOffers : [];
            if (ownedOffers.length > 0 && debtAssetId && collateralAssetId) {
                const debtAsset = await this._resolveAsset(debtAssetId);
                const collateralAsset = await this._resolveAsset(collateralAssetId);
                if (debtAsset && collateralAsset) {
                    const match = ownedOffers.find((o: any) =>
                        String(o.assetType) === String(debtAssetId) && o.enabled !== false
                    );
                    if (match) {
                        const collateralMap = normalizeCollateralMap(match.acceptableCollateral);
                        const rate = this._extractRateFromCollateralMap(collateralMap, String(collateralAssetId), debtAsset, collateralAsset);
                        if (rate !== null) {
                            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                            this.state.positions[posKey].creditConversionRate = rate;
                            this.state.positions[posKey].creditConversionRateAt = Date.now();
                            return options.includeSource ? { price: rate, source: 'owned-offer' } : rate;
                        }
                    }
                }
            }
            if (options.includeSource) {
                return cachedIsFresh
                    ? { price: cached, source: 'cached-offer' }
                    : { price: null, source: 'missing-offer' };
            }
            return cachedIsFresh ? cached : null;
        }

        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        if (!debtAsset || !collateralAsset) {
            if (options.includeSource) {
                return cachedIsFresh
                    ? { price: cached, source: 'cached-offer' }
                    : { price: null, source: 'missing-offer' };
            }
            return cachedIsFresh ? cached : null;
        }

        const offerObjects = await this._dbCall('get_objects', [Array.from(offerIds)]);
        if (Array.isArray(offerObjects)) {
            for (const offer of offerObjects) {
                if (!offer || String(offer.asset_type) !== String(debtAssetId)) continue;
                if (offer.enabled === false) continue;

                const collateralMap = normalizeCollateralMap(offer?.acceptable_collateral);
                const rate = this._extractRateFromCollateralMap(collateralMap, String(collateralAssetId), debtAsset, collateralAsset);
                if (rate === null) continue;

                if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                this.state.positions[posKey].creditConversionRate = rate;
                this.state.positions[posKey].creditConversionRateAt = Date.now();
                return options.includeSource ? { price: rate, source: 'live-offer' } : rate;
            }
        }

        if (options.includeSource) {
            return cachedIsFresh
                ? { price: cached, source: 'cached-offer' }
                : { price: null, source: 'missing-offer' };
        }
        return cachedIsFresh ? cached : null;
    }

    async _calculateCollateralDistribution() {
        const dp = this.debtPolicy;
        if (!dp || !Array.isArray(dp.lending)) return;

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return;

        // Group lending items by their collateral asset
        const groups = new Map();
        for (const item of dp.lending) {
            const ref = item.collateralAsset;
            if (!ref) continue;
            if (!groups.has(ref)) groups.set(ref, []);
            groups.get(ref).push(item);
        }

        const validAssetIds = new Set();

        for (const [collateralRef, items] of groups) {
            const collateralAsset = await this._resolveAsset(collateralRef);
            if (!collateralAsset) continue;

            const totalCollateralAvailable = await this._getCollateralPercentageBase(accountRef, collateralAsset.id);
            const totalMaxCollateral = resolveConfigValue(dp.maxCollateralAmount ?? '100%', totalCollateralAvailable);
            const C_total = Math.min(totalCollateralAvailable, totalMaxCollateral);

            let groupHasNoUsablePrice = false;
            const weightEntries = await Promise.all(
                items.map(async (item: any) => {
                    const ratio = item.outputWeight ?? item.ratio ?? 1;
                    const resolvedAsset = await this._resolveAsset(item.asset);
                    const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;

                    let targetCr = 1.0;
                    let weight = 0;

                    if (item.type === 'mpa') {
                        targetCr = resolveTargetCollateralRatio(item) ?? DEFAULT_TARGET_CR;
                        const resolvedFeedPrice = assetId
                            ? normalizeResolvedPriceResult(
                                await this._resolveMpaFeedPrice(assetId, collateralAsset.id, { includeSource: true }),
                                'live-feed',
                                'missing-feed'
                            )
                            : { price: null, source: 'missing-feed' };
                        if (resolvedFeedPrice.price !== null) {
                            weight = ratio * resolvedFeedPrice.price * targetCr;
                            if (resolvedFeedPrice.source === 'cached-feed') {
                                this.warn(`credit runtime: live MPA feed price unavailable for ${item.asset}; using last known feed price for collateral group ${collateralRef}`);
                            }
                        } else {
                            if (assetId) {
                                this.warn(`credit runtime: unable to resolve MPA feed price for ${item.asset}; no usable last known feed price for collateral group ${collateralRef}`);
                                groupHasNoUsablePrice = true;
                            }
                        }
                    } else if (item.type === 'creditOffer') {
                        targetCr = toFiniteNumber(item.maxCollateralRatio, 2.0);
                        const resolvedConversionRate = assetId
                            ? normalizeResolvedPriceResult(
                                await this._resolveCreditConversionRate(item, assetId, collateralAsset.id, { includeSource: true }),
                                'live-offer',
                                'missing-offer'
                            )
                            : { price: null, source: 'missing-offer' };
                        if (resolvedConversionRate.price !== null) {
                            weight = (ratio * targetCr) / resolvedConversionRate.price;
                            if (resolvedConversionRate.source === 'cached-offer') {
                                this.warn(`credit runtime: live credit offer price unavailable for ${item.asset}; using last known price for collateral group ${collateralRef}`);
                            }
                        } else {
                            if (assetId) {
                                this.warn(`credit runtime: unable to resolve credit offer price for ${item.asset}; no usable last known price for collateral group ${collateralRef}`);
                                groupHasNoUsablePrice = true;
                            }
                        }
                    } else {
                        weight = ratio * targetCr;
                    }

                    return { item, weight, assetId };
                })
            );

            if (groupHasNoUsablePrice) {
                // Keep existing assignedCollateralBudget for this group's positions until a live or cached price is available again.
                for (const item of items) {
                    const resolvedAsset = await this._resolveAsset(item.asset);
                    const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                    if (assetId && collateralAsset.id) {
                        const posKey = this._positionKey(assetId, collateralAsset.id);
                        validAssetIds.add(posKey);
                    }
                }
                continue;
            }

            const totalWeight = weightEntries.reduce((sum, e) => sum + e.weight, 0);
            if (totalWeight === 0) continue;

            for (const { weight, assetId } of weightEntries) {
                if (!assetId || !collateralAsset.id) continue;
                const posKey = this._positionKey(assetId, collateralAsset.id);
                validAssetIds.add(posKey);
                const C_i = (C_total * weight) / totalWeight;
                if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                this.state.positions[posKey].assignedCollateralBudget = C_i;
            }
        }

        for (const key of Object.keys(this.state.positions)) {
            if (!validAssetIds.has(key)) {
                delete this.state.positions[key];
            }
        }
    }

    _creditPriceOrientation(collateralPrice: any, debtAsset: any, collateralAsset: any): string {
        const baseAssetId = String(collateralPrice?.base?.asset_id || '');
        const quoteAssetId = String(collateralPrice?.quote?.asset_id || '');
        const debtAssetId = String(debtAsset?.id || '');
        const collateralAssetId = String(collateralAsset?.id || '');
        if (baseAssetId === debtAssetId && quoteAssetId === collateralAssetId) return 'core';
        if (baseAssetId === collateralAssetId && quoteAssetId === debtAssetId) return 'legacy-reversed';
        return 'core';
    }

    _extractRateFromCollateralMap(collateralMap: Map<string, any>, collateralAssetId: string, debtAsset: any, collateralAsset: any): number | null {
        const price = collateralMap.get(collateralAssetId);
        if (!price) return null;
        const orientation = this._creditPriceOrientation(price, debtAsset, collateralAsset);
        const baseAmount = blockchainAmountToFloat(price?.base, orientation === 'legacy-reversed' ? collateralAsset : debtAsset);
        const quoteAmount = blockchainAmountToFloat(price?.quote, orientation === 'legacy-reversed' ? debtAsset : collateralAsset);
        if (baseAmount == null || quoteAmount == null || baseAmount <= 0) return null;
        const rate = orientation === 'legacy-reversed'
            ? quoteAmount / baseAmount
            : baseAmount / quoteAmount;
        if (!Number.isFinite(rate) || rate <= 0) return null;
        return rate;
    }

    _calculateBorrowAmountFromCollateral(collateralAmountInt: any, collateralPrice: any, debtAsset: any = null, collateralAsset: any = null): number | null {
        const baseAmount = toFiniteNumber(collateralPrice?.base?.amount, undefined);
        const quoteAmount = toFiniteNumber(collateralPrice?.quote?.amount, undefined);
        if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }
        if (this._creditPriceOrientation(collateralPrice, debtAsset, collateralAsset) === 'legacy-reversed') {
            return Math.floor((Number(collateralAmountInt) * quoteAmount) / baseAmount);
        }
        return Math.floor((Number(collateralAmountInt) * baseAmount) / quoteAmount);
    }

    _enforceMaxBorrowAmount(policy: any, borrowInt: any, debtAsset: any, options: Record<string, any> = {}): void {
        const maxBorrowAmountValue = positiveOrNull(policy?.maxBorrowAmount);
        if (maxBorrowAmountValue === null) return;
        const borrowFloat = blockchainToFloat(borrowInt, debtAsset.precision);
        if (!Number.isFinite(borrowFloat)) return;
        const currentTotal = this._getCreditDebtForAsset(debtAsset);
        const pendingRepayFloat = Number(options.pendingRepayAmount) || 0;
        if (currentTotal - pendingRepayFloat + borrowFloat > maxBorrowAmountValue) {
            throw new Error(`borrowAmount ${borrowFloat} would exceed maxBorrowAmount ${maxBorrowAmountValue} (current total ${currentTotal}, pending repay ${pendingRepayFloat})`);
        }
    }

    _getCreditDebtForAsset(asset: any): number {
        const assetId = asset?.id || asset;
        const deals = Array.isArray(this.state?.creditDeals) ? this.state.creditDeals : [];
        return deals.reduce((sum: any, deal: any) => {
            if (String(deal?.debtAssetId) === String(assetId)) {
                return sum + (blockchainAmountToFloat(deal?.debtAmount, asset) || 0);
            }
            return sum;
        }, 0);
    }

    _getCreditCollateralForAsset(asset: any): number {
        const assetId = asset?.id || asset;
        const deals = Array.isArray(this.state?.creditDeals) ? this.state.creditDeals : [];
        return deals.reduce((sum: any, deal: any) => {
            if (String(deal?.collateralAssetId) === String(assetId)) {
                return sum + (blockchainAmountToFloat(deal?.collateralAmount, asset) || 0);
            }
            return sum;
        }, 0);
    }

    async _getCollateralPercentageBase(accountId: any, assetId: any): Promise<any> {
        if (!accountId || !assetId) return null;

        const asset = await this._resolveAsset(assetId);
        if (!asset) return null;

        const [balances, account, deals] = await Promise.all([
            chainOrders.getOnChainAssetBalances(accountId, [assetId]),
            this._getFullAccount(accountId).catch(() => null),
            this._fetchBorrowerDeals().catch(() => []),
        ]);

        const balance = (balances as Record<string, any>)?.[String(assetId)] || (balances as Record<string, any>)?.[String(asset.symbol)] || null;
        const onChainTotal = toFiniteNumber(balance?.total, undefined);
        if (!Number.isFinite(onChainTotal)) {
            return null;
        }

        let committed = 0;
        for (const order of parseCallOrders(account)) {
            const orderCollateralAssetId = order?.call_price?.base?.asset_id || null;
            if (String(orderCollateralAssetId) !== String(assetId)) continue;
            committed += blockchainAmountToFloat(order?.collateral, asset) || 0;
        }

        for (const deal of deals) {
            if (String(deal?.collateralAssetId) !== String(assetId)) continue;
            const dealAsset = await this._resolveAsset(deal.collateralAssetId);
            committed += blockchainAmountToFloat(deal?.collateralAmount, dealAsset || asset) || 0;
        }

        const total = onChainTotal + committed;

        // Apply registry proportional split for shared-account credit bots
        const accountName = getAccountName(this.bot);
        const botName = this.botKey;
        if (accountName && botName) {
            const effective = fundRegistry.getEffectiveCollateralAllocationSync(accountName, botName, assetId, total);
            if (effective !== null) return effective;
        }

        return total;
    }

    async _enforceMaxCollateralAmount(policy: any, collateralInt: any, collateralAsset: any, accountId: any, options: Record<string, any> = {}): Promise<void> {
        const maxCollateralAmountValue = policy?.maxCollateralAmount;
        if (maxCollateralAmountValue == null) return;
        let limitFloat = positiveOrNull(maxCollateralAmountValue);
        if (limitFloat === null) {
            const trimmed = typeof maxCollateralAmountValue === 'string' ? maxCollateralAmountValue.trim() : '';
            if (!trimmed.endsWith('%')) return;
            const referenceAmount = await this._getCollateralPercentageBase(accountId, collateralAsset.id);
            if (!Number.isFinite(referenceAmount)) {
                throw new Error(`Unable to resolve collateral percentage base for ${collateralAsset.id}`);
            }
            limitFloat = resolveConfigValue(maxCollateralAmountValue, referenceAmount);
        }
        if (!Number.isFinite(limitFloat) || limitFloat < 0) return;
        const collateralFloat = blockchainToFloat(collateralInt, collateralAsset.precision);
        if (!Number.isFinite(collateralFloat)) return;
        const currentTotal = this._getCreditCollateralForAsset(collateralAsset);
        const pendingReleaseFloat = Number(options.pendingReleaseCollateralAmount) || 0;
        if (currentTotal - pendingReleaseFloat + collateralFloat > limitFloat) {
            throw new Error(`collateralAmount ${collateralFloat} would exceed maxCollateralAmount ${limitFloat} (current total ${currentTotal}, pending release ${pendingReleaseFloat})`);
        }
    }

    _calculateDailyFeeRate(offer: any): number {
        const feeRate = toFiniteNumber(offer?.fee_rate, 0) || 0;
        const maxDurationSeconds = toFiniteNumber(offer?.max_duration_seconds, 0) || 0;
        if (feeRate <= 0 || maxDurationSeconds <= 0) return 0;
        const feeRateDenom = this.bot?.config?.feeParams?.GRAPHENE_FEE_RATE_DENOM ?? FEE_PARAMETERS.GRAPHENE_FEE_RATE_DENOM;
        const flatFeePercent = feeRate / feeRateDenom;
        const durationDays = maxDurationSeconds / 86400;
        return flatFeePercent / durationDays;
    }

    _getDefaultMaxFeeRatePerDay(): number {
        return this.bot?.config?.feeParams?.DEFAULT_MAX_FEE_RATE_PER_DAY ?? FEE_PARAMETERS.DEFAULT_MAX_FEE_RATE_PER_DAY;
    }

    _validateCreditPolicy(policy: any, offer: any, deal: any = null): any {
        if (!policy || typeof policy !== 'object') return { allow: false, reason: 'creditOffer policy missing' };
        const allowedOfferIds = this._normalizePolicyList(policy.allowedOfferIds);
        const maxFeeRatePerDay = positiveOrNull(policy.maxFeeRatePerDay) ?? this._getDefaultMaxFeeRatePerDay();
        const maxBorrowAmount = positiveOrNull(policy.maxBorrowAmount);
        const maxCollateralAmount = positiveOrPercentOrNull(policy.maxCollateralAmount);
        const maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);

        if (maxCollateralRatio === null) {
            return { allow: false, reason: 'creditOffer maxCollateralRatio is required' };
        }
        if (policy.maxBorrowAmount != null && maxBorrowAmount === null) {
            return { allow: false, reason: 'creditOffer maxBorrowAmount must be positive' };
        }
        if (policy.maxCollateralAmount != null && maxCollateralAmount === null) {
            return { allow: false, reason: 'creditOffer maxCollateralAmount must be positive or percentage' };
        }

        if (allowedOfferIds.length > 0 && offer?.id && !allowedOfferIds.includes(String(offer.id))) {
            return { allow: false, reason: `offer ${offer.id} is not allowed` };
        }

        if (deal) {
            if (allowedOfferIds.length > 0 && deal.offerId && !allowedOfferIds.includes(String(deal.offerId))) {
                return { allow: false, reason: `deal offer ${deal.offerId} is not allowed` };
            }
        }

        const dailyRate = this._calculateDailyFeeRate(offer);
        if (dailyRate > maxFeeRatePerDay) {
            return { allow: false, reason: `offer daily fee rate ${dailyRate.toFixed(6)} exceeds maxFeeRatePerDay ${maxFeeRatePerDay}` };
        }

        return { allow: true, reason: null };
    }

    async _calculateCollateralValueInDebtAsset(collateralAmountInt: any, collateralAsset: any, debtAsset: any, collateralPrice: any): Promise<any> {
        const collateralAmountFloat = blockchainToFloat(collateralAmountInt, collateralAsset.precision);
        if (!Number.isFinite(collateralAmountFloat) || collateralAmountFloat <= 0) {
            return null;
        }

        if (collateralAsset?.for_liquidity_pool) {
            const valuePerShare = await deriveLiquidityPoolTokenValue(BitShares, collateralAsset.id, debtAsset.id);
            if (valuePerShare == null || !Number.isFinite(valuePerShare) || valuePerShare <= 0) {
                return null;
            }
            return collateralAmountFloat * valuePerShare;
        }

        const orientation = this._creditPriceOrientation(collateralPrice, debtAsset, collateralAsset);
        const baseAmountFloat = blockchainAmountToFloat(collateralPrice?.base, orientation === 'legacy-reversed' ? collateralAsset : debtAsset);
        const quoteAmountFloat = blockchainAmountToFloat(collateralPrice?.quote, orientation === 'legacy-reversed' ? debtAsset : collateralAsset);
        if (baseAmountFloat == null || quoteAmountFloat == null || baseAmountFloat <= 0 || quoteAmountFloat <= 0) {
            return null;
        }
        if (orientation === 'legacy-reversed') {
            return (collateralAmountFloat * quoteAmountFloat) / baseAmountFloat;
        }
        return (collateralAmountFloat * baseAmountFloat) / quoteAmountFloat;
    }

    _calculateCreditOfferCollateralValueInDebtAsset(collateralAmountInt: any, collateralAsset: any, debtAsset: any, collateralPrice: any): number | null {
        const collateralAmountFloat = blockchainToFloat(collateralAmountInt, collateralAsset.precision);
        if (!Number.isFinite(collateralAmountFloat) || collateralAmountFloat <= 0) {
            return null;
        }

        const orientation = this._creditPriceOrientation(collateralPrice, debtAsset, collateralAsset);
        const baseAmountFloat = blockchainAmountToFloat(collateralPrice?.base, orientation === 'legacy-reversed' ? collateralAsset : debtAsset);
        const quoteAmountFloat = blockchainAmountToFloat(collateralPrice?.quote, orientation === 'legacy-reversed' ? debtAsset : collateralAsset);
        if (baseAmountFloat == null || quoteAmountFloat == null || baseAmountFloat <= 0 || quoteAmountFloat <= 0) {
            return null;
        }
        if (orientation === 'legacy-reversed') {
            return (collateralAmountFloat * quoteAmountFloat) / baseAmountFloat;
        }
        return (collateralAmountFloat * baseAmountFloat) / quoteAmountFloat;
    }

    async _fetchBorrowerDeals(): Promise<any[]> {
        if (this._borrowerDealsCache !== null) return this._borrowerDealsCache;
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return [];
        const accountId = await this._resolveAccountId(accountRef);
        if (!accountId) return [];
        const dealObjects = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        const normalized = Array.isArray(dealObjects) ? dealObjects.map(parseDealSummary).filter(Boolean) : [];
        this._borrowerDealsCache = normalized;
        return normalized;
    }

    async _fetchOwnedCreditOffers(): Promise<any[]> {
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return [];
        }

        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const offers = await this._dbCall('get_credit_offers_by_owner', [accountId]);
        return Array.isArray(offers) ? offers.map(parseCreditOfferSummary).filter(Boolean) : [];
    }

    async _buildDebtSnapshot(): Promise<any> {
        const snapshot: Record<string, any> = {
            assets: {},
            mpaCallOrders: Array.isArray(this.state.mpaCallOrders) ? this.state.mpaCallOrders : [],
            creditDeals: Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [],
            ownedCreditOffers: Array.isArray(this.state.ownedCreditOffers) ? this.state.ownedCreditOffers : [],
        };

        const bump = (assetId: any, field: any, amount: any): void => {
            if (!assetId || !Number.isFinite(amount) || amount === 0) return;
            const key = String(assetId);
            if (!snapshot.assets[key]) {
                snapshot.assets[key] = {
                    assetId: key,
                    mpaDebt: 0,
                    mpaCollateral: 0,
                    creditDebt: 0,
                    creditCollateral: 0,
                    offeredBalance: 0,
                    totalDebt: 0,
                    totalCollateral: 0,
                };
            }
            snapshot.assets[key][field] += amount;
        };

        for (const order of snapshot.mpaCallOrders) {
            const debtAsset = order?.debtAssetId ? await this._resolveAsset(order.debtAssetId) : null;
            const collateralAsset = order?.collateralAssetId ? await this._resolveAsset(order.collateralAssetId) : null;
            bump(order?.debtAssetId, 'mpaDebt', blockchainAmountToFloat(order?.debtAmount, debtAsset) || 0);
            bump(order?.collateralAssetId, 'mpaCollateral', blockchainAmountToFloat(order?.collateralAmount, collateralAsset) || 0);
        }

        for (const deal of snapshot.creditDeals) {
            const debtAsset = deal?.debtAssetId ? await this._resolveAsset(deal.debtAssetId) : null;
            const collateralAsset = deal?.collateralAssetId ? await this._resolveAsset(deal.collateralAssetId) : null;
            bump(deal?.debtAssetId, 'creditDebt', blockchainAmountToFloat(deal?.debtAmount, debtAsset) || 0);
            bump(deal?.collateralAssetId, 'creditCollateral', blockchainAmountToFloat(deal?.collateralAmount, collateralAsset) || 0);
        }

        for (const offer of snapshot.ownedCreditOffers) {
            const asset = offer?.assetType ? await this._resolveAsset(offer.assetType) : null;
            bump(offer?.assetType, 'offeredBalance', blockchainAmountToFloat(offer?.currentBalance, asset) || 0);
        }

        for (const entry of (Object.values(snapshot.assets) as any[])) {
            entry.totalDebt = (entry.mpaDebt || 0) + (entry.creditDebt || 0);
            entry.totalCollateral = (entry.mpaCollateral || 0) + (entry.creditCollateral || 0);
        }

        return snapshot;
    }

    async refreshMpaState(lendingItem: any): Promise<any> {
        await this.loadState();
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('refreshMpaState requires a lendingItem');
        }

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return null;
        }

        const debtAsset = await this._resolveAsset(lendingItem.asset);
        if (!debtAsset || !debtAsset.id) {
            return null;
        }
        const assetId = String(debtAsset.id);

        const account = await this._getFullAccount(accountRef);
        const callOrders = parseCallOrders(account).map(parseCallOrderSummary).filter(Boolean);
        this.state.mpaCallOrders = callOrders;

        const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const configuredCollateralAssetId = configuredCollateralAsset?.id ? String(configuredCollateralAsset.id) : null;
        const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;

        const candidateOrders = callOrders.filter((entry) =>
            String(entry?.call_price?.quote?.asset_id) === assetId
        );

        const createEmptyState = (reason: any): any => {
            const empty = {
                activeCallOrderId: null,
                mpaSelectionConflict: reason || null,
                debtAssetId: assetId,
                currentCollateralAssetId: null,
                currentDebtAmount: 0,
                currentCollateralAmount: 0,
                currentCollateralFundsTotal: null,
                currentCollateralRatio: null,
                feedPrice: null,
                targetCollateralRatio: resolveTargetCollateralRatio(lendingItem),
                minCollateralRatio: positiveOrNull(lendingItem.minCollateralRatio),
                maxCollateralRatio: positiveOrNull(lendingItem.maxCollateralRatio),
            };
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            Object.assign(this.state.positions[posKey], empty);
            return empty;
        };

        if (candidateOrders.length === 0) {
            return createEmptyState('no matching MPA position');
        }

        if (candidateOrders.length > 1) {
            const reason = `multiple matching MPA positions found for ${assetId} in ${this.botKey}`;
            this.warn(`credit runtime: ${reason}; refusing to select one automatically`);
            return createEmptyState(reason);
        }

        const callOrder = candidateOrders[0];
        const callOrderCollateralAssetId = callOrder?.call_price?.base?.asset_id || null;
        const collateralAsset = callOrderCollateralAssetId ? await this._resolveAsset(callOrderCollateralAssetId) : null;

        if (configuredCollateralAssetId && callOrderCollateralAssetId && String(callOrderCollateralAssetId) !== String(configuredCollateralAssetId)) {
            return createEmptyState(`call order collateral ${callOrderCollateralAssetId} does not match configured collateral ${configuredCollateralAssetId}`);
        }

        const bitassetData = await this._resolveBitassetData(assetId);

        const debtAmount = blockchainAmountToFloat(callOrder?.debt, debtAsset) || 0;
        const collateralAmount = blockchainAmountToFloat(callOrder?.collateral, collateralAsset) || 0;
        const collateralBalances = callOrderCollateralAssetId ? await chainOrders.getOnChainAssetBalances(accountRef, [callOrderCollateralAssetId]) : {};
        const collateralBalance = callOrderCollateralAssetId ? ((collateralBalances as Record<string, any>)?.[String(callOrderCollateralAssetId)] || (collateralBalances as Record<string, any>)?.[String(collateralAsset?.symbol)] || null) : null;
        let currentCollateralFundsTotal = toFiniteNumber(collateralBalance?.total, undefined);

        // Apply registry proportional split for shared-account credit bots
        if (currentCollateralFundsTotal !== null && callOrderCollateralAssetId) {
            const accountName = getAccountName(this.bot);
            const botName = this.botKey;
            if (accountName && botName) {
                const effective = fundRegistry.getEffectiveCollateralAllocationSync(accountName, botName, callOrderCollateralAssetId, currentCollateralFundsTotal);
                if (effective !== null) currentCollateralFundsTotal = effective;
            }
        }

        const feedPrice = this._computeBtsPerDebt(bitassetData?.current_feed?.settlement_price, debtAsset, collateralAsset);
        if (feedPrice != null && Number.isFinite(feedPrice) && feedPrice > 0) {
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].mpaFeedPrice = feedPrice;
        }
        const currentCollateralRatio = debtAmount > 0 && feedPrice != null && feedPrice > 0
            ? collateralAmount / (debtAmount * feedPrice)
            : null;

        const posState = {
            activeCallOrderId: callOrder.id || null,
            debtAssetId: assetId,
            currentCollateralAssetId: callOrderCollateralAssetId,
            currentDebtAmount: debtAmount,
            currentCollateralAmount: collateralAmount,
            currentCollateralFundsTotal,
            currentCollateralRatio,
            feedPrice,
            targetCollateralRatio: resolveTargetCollateralRatio(lendingItem),
            minCollateralRatio: positiveOrNull(lendingItem.minCollateralRatio),
            maxCollateralRatio: positiveOrNull(lendingItem.maxCollateralRatio),
            mpaSelectionConflict: null,
        };

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        Object.assign(this.state.positions[posKey], posState);

        return posState;
    }

    async refreshCreditState(options: Record<string, any> = {}, lendingItem: any): Promise<any> {
        await this.loadState();
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('refreshCreditState requires a lendingItem');
        }

        const debtAsset = await this._resolveAsset(lendingItem.asset);
        if (!debtAsset || !debtAsset.id) {
            return null;
        }
        const assetId = String(debtAsset.id);

        const normalizedDeals = Array.isArray(options.deals)
            ? options.deals.map(parseDealSummary).filter(Boolean)
            : await this._fetchBorrowerDeals();
        const ownedCreditOffers = Array.isArray(options.ownedCreditOffers)
            ? options.ownedCreditOffers.map(parseCreditOfferSummary).filter(Boolean)
            : await this._fetchOwnedCreditOffers();
        const trackedOffers = new Map();

        const offerIdsFromDeals = normalizedDeals.map((deal) => deal.offerId).filter(Boolean);
        const offerIds = Array.from(new Set(offerIdsFromDeals.map(String)));

        if (offerIds.length > 0) {
            const offerObjects = await this._dbCall('get_objects', [offerIds]);
            if (Array.isArray(offerObjects)) {
                for (const offer of offerObjects) {
                    if (offer && offer.id) {
                        trackedOffers.set(String(offer.id), offer);
                    }
                }
            }
        }

        const expectedCollateralAssetObj = await this._resolveAsset(lendingItem.collateralAsset);
        const expectedCollateralId = expectedCollateralAssetObj?.id ? String(expectedCollateralAssetObj.id) : null;
        const posKey = expectedCollateralId ? this._positionKey(assetId, expectedCollateralId) : assetId;

        // Cache conversion rate from discovered offers to avoid duplicate fetches in distribution.
        // This is a price for the debt+collateral asset pair, not for a specific offer id.
        // In practice, offers for the same pair should expose interchangeable acceptable-collateral pricing.
        if (expectedCollateralId) {
            const debtAssetResolved = await this._resolveAsset(assetId);
            const collateralAssetResolved = await this._resolveAsset(expectedCollateralId);
            if (debtAssetResolved && collateralAssetResolved) {
                for (const offer of trackedOffers.values()) {
                    if (String(offer?.asset_type) !== assetId) continue;
                    if (offer?.enabled === false) continue;
                    const collateralMap = normalizeCollateralMap(offer?.acceptable_collateral);
                    const rate = this._extractRateFromCollateralMap(collateralMap, expectedCollateralId, debtAssetResolved, collateralAssetResolved);
                    if (rate === null) continue;
                    if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                    this.state.positions[posKey].creditConversionRate = rate;
                    this.state.positions[posKey].creditConversionRateAt = Date.now();
                    break;
                }

                // Fallback: cache conversion rate from owned credit offers.
                // This ensures pricing is available even when there are no active
                // borrowing deals and allowedOfferIds is empty.
                if (!this.state.positions[posKey]?.creditConversionRate) {
                    for (const offer of ownedCreditOffers) {
                        if (String(offer.assetType) !== assetId) continue;
                        if (offer.enabled === false) continue;
                        const collateralMap = normalizeCollateralMap(offer.acceptableCollateral);
                        const rate = this._extractRateFromCollateralMap(collateralMap, expectedCollateralId, debtAssetResolved, collateralAssetResolved);
                        if (rate === null) continue;
                        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                        this.state.positions[posKey].creditConversionRate = rate;
                        this.state.positions[posKey].creditConversionRateAt = Date.now();
                        break;
                    }
                }
            }
        }

        const activeDeals: any[] = [];
        for (const deal of normalizedDeals) {
            if (String(deal.debtAssetId) !== assetId) {
                continue;
            }
            if (expectedCollateralId && deal.collateralAssetId && String(deal.collateralAssetId) !== expectedCollateralId) {
                activeDeals.push({
                    ...deal,
                    offerEnabled: false,
                    offerFeeRate: deal.feeRate,
                    canReborrow: false,
                    collateralMismatch: true,
                });
                continue;
            }
            const offer = deal.offerId ? trackedOffers.get(String(deal.offerId)) : null;
            const validation = this._validateCreditPolicy(lendingItem, offer, deal);
            if (!validation.allow) {
                continue;
            }
            activeDeals.push({
                ...deal,
                offerEnabled: !!offer?.enabled,
                offerFeeRate: toFiniteNumber(offer?.fee_rate, deal.feeRate) || deal.feeRate,
                offerMaxDurationSeconds: toFiniteNumber(offer?.max_duration_seconds, undefined),
                canReborrow: !!offer?.enabled,
            });
        }

        const activeDealIds = activeDeals.map((deal) => deal.id).filter(Boolean);
        const activeOfferIds = Array.from(new Set(activeDeals.map((deal) => deal.offerId).filter(Boolean)));

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        this.state.positions[posKey].creditDeals = activeDeals;
        this.state.positions[posKey].activeDealIds = activeDealIds;
        this.state.positions[posKey].activeOfferIds = activeOfferIds;

        this._rebuildCreditTrackingFromPositions();

        this.state.ownedCreditOffers = ownedCreditOffers;
        this.state.lastBorrowRequest = this.state.lastBorrowRequest || null;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        return this.state;
    }

    async refreshState(): Promise<any> {
        this._assetCache.clear();
        this._objectCache.clear();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        await this.loadState();
        const dp = this.debtPolicy;
        if (!dp || !Array.isArray(dp.lending)) {
            return this.persistState('refresh');
        }

        const allDeals = await this._fetchBorrowerDeals();

        for (const item of dp.lending) {
            if (item.type === 'mpa') {
                await this.refreshMpaState(item);
            } else if (item.type === 'creditOffer') {
                await this.refreshCreditState({ deals: allDeals }, item);
            }
        }
        await this._pruneCreditStateForPolicy(dp.lending);
        await this._calculateCollateralDistribution();
        this._rebuildCreditTrackingFromPositions();

        this.state.debtSnapshot = await this._buildDebtSnapshot();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        return this.persistState('refresh');
    }

    async _buildMpaPlanFromState(lendingItem: any, assetId: any): Promise<any> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_buildMpaPlanFromState requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_buildMpaPlanFromState requires an assetId');
        }
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const collateralAssetId = collateralAsset?.id;
        const posKey = collateralAssetId ? this._positionKey(assetId, collateralAssetId) : assetId;
        const posState = this.state.positions[posKey];
        if (!posState) return null;

        if (posState.mpaSelectionConflict) {
            return { blocked: true, reason: posState.mpaSelectionConflict };
        }
        const plan = buildDebtFirstCrPlan({
            currentCollateralAmount: posState.currentCollateralAmount,
            currentDebtAmount: posState.currentDebtAmount,
            feedPrice: posState.feedPrice,
            minCollateralRatio: lendingItem.minCollateralRatio,
            maxCollateralRatio: lendingItem.maxCollateralRatio,
            targetCollateralRatio: lendingItem.targetCollateralRatio,
            maxBorrowAmount: lendingItem.maxBorrowAmount,
            maxBorrowAmountPerOperation: lendingItem.maxBorrowAmountPerOperation,
            maxCollateralAmount: posState.assignedCollateralBudget ?? lendingItem.maxCollateralAmount,
            collateralLimitReferenceAmount: posState.currentCollateralFundsTotal,
            minCollateralIncreaseThreshold: lendingItem.minCollateralIncreaseThreshold,
            debtOnly: lendingItem.debtOnly,
        });

        if (!plan) return null;
        if (plan.blocked) return plan;
        return plan;
    }

    async buildMpaUpdateOperation(plan: any, options: Record<string, any> = {}, lendingItem: any, assetId: any): Promise<any> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('buildMpaUpdateOperation requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('buildMpaUpdateOperation requires an assetId');
        }
        const policy = lendingItem;

        if (!policy || !plan) return null;
        if (plan.blocked) {
            throw new Error(plan.reason || 'MPA plan blocked');
        }

        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const collateralAssetId = collateralAsset?.id;
        const posKey = collateralAssetId ? this._positionKey(assetId, collateralAssetId) : assetId;
        const posState = this.state.positions[posKey];
        if (!posState) return null;

        const leg = options.leg || 'combined';

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for MPA update');
        }

        const debtAsset = posState.debtAssetId ? await this._resolveAsset(posState.debtAssetId) : null;
        const account = await this._getFullAccount(getAccountRef(this.bot));
        const currentCallOrder = parseCallOrders(account).find((entry) => entry.id === posState.activeCallOrderId) || null;
        const callOrderCollateralAssetId = currentCallOrder?.call_price?.base?.asset_id || null;
        const callOrderCollateralAsset = callOrderCollateralAssetId ? await this._resolveAsset(callOrderCollateralAssetId) : null;

        if (!debtAsset || !callOrderCollateralAsset) {
            throw new Error('Unable to resolve MPA asset metadata');
        }

        const debtDelta = leg === 'collateral' ? 0 : plan.debtDelta;
        const collateralDelta = leg === 'debt' ? 0 : plan.collateralDelta;
        const debtInt = floatToBlockchainInt(debtDelta, debtAsset.precision);
        const collateralInt = floatToBlockchainInt(collateralDelta, callOrderCollateralAsset.precision);
        if (debtInt === 0 && collateralInt === 0) {
            return null;
        }

        const extensions: Record<string, any> = {};
        const targetCollateralRatio = toGrapheneCollateralRatio(plan.targetCollateralRatio);
        if (targetCollateralRatio !== null) {
            extensions.target_collateral_ratio = targetCollateralRatio;
        }

        return {
            op_name: 'call_order_update',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                funding_account: accountId,
                delta_collateral: toAmountObject(collateralInt, callOrderCollateralAsset.id),
                delta_debt: toAmountObject(debtInt, debtAsset.id),
                extensions,
            }
        };
    }

    async buildCreditOfferAcceptOperation({ offer, borrowAmount, collateralAmount, autoRepay = false, specificPolicy = null, pendingRepayAmount = null, pendingReleaseCollateralAmount = null }: { offer?: any; borrowAmount?: any; collateralAmount?: any; autoRepay?: boolean; specificPolicy?: any; pendingRepayAmount?: any; pendingReleaseCollateralAmount?: any; } = {}): Promise<any> {
        let policy = specificPolicy;
        if (!policy) {
            const dp = this.debtPolicy;
            const offerObj = typeof offer === 'object' ? offer : null;
            const offerDebtAssetId = offerObj?.asset_type || null;
            if (dp?.lending && offerDebtAssetId) {
                for (const item of dp.lending) {
                    if (item.type !== 'creditOffer') continue;
                    let cached = this._assetCache.get(String(item.asset));
                    if (!cached && item.asset) {
                        cached = await this._resolveAsset(item.asset);
                    }
                    if (cached && String(cached.id) === String(offerDebtAssetId)) {
                        policy = item;
                        break;
                    }
                }
            }
        }
        if (!policy) {
            throw new Error('creditOffer policy missing');
        }
        const renewOnly = policy.renewOnly === true;
        const isReborrowContext = pendingRepayAmount !== null && pendingRepayAmount !== undefined
            || pendingReleaseCollateralAmount !== null && pendingReleaseCollateralAmount !== undefined;
        if (renewOnly && !isReborrowContext) {
            throw new Error('creditOffer policy is renewOnly; refusing standalone credit borrow');
        }

        const offerObj = typeof offer === 'object' ? offer : null;
        const offerId = offerObj?.id || offer;
        if (!offerId) {
            throw new Error('credit offer id is required');
        }

        const validation = this._validateCreditPolicy(policy, offerObj, null);
        if (!validation.allow) {
            throw new Error(validation.reason || 'credit offer rejected by policy');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit offer accept');
        }

        const debtAssetId = offerObj?.asset_type || null;
        const debtAsset = debtAssetId ? await this._resolveAsset(debtAssetId) : null;
        if (!debtAsset) {
            throw new Error('Unable to resolve debt asset metadata for credit offer');
        }

        const collateralMap = normalizeCollateralMap(offerObj?.acceptable_collateral);
        const collateralSpec = normalizeAmountSpec(collateralAmount);
        const collateralAssetId = collateralSpec?.assetId || offerObj?.collateral_asset_id || null;
        if (!collateralAssetId && collateralMap.size > 1) {
            throw new Error('collateral asset is required for multi-asset credit offers');
        }
        let collateralPrice = collateralAssetId ? collateralMap.get(String(collateralAssetId)) : null;
        if (!collateralPrice && collateralMap.size === 1 && !collateralAssetId) {
            collateralPrice = collateralMap.values().next().value;
        }
        if (!collateralPrice) {
            if (collateralAssetId && collateralMap.size > 0) {
                throw new Error(`collateral asset ${collateralAssetId} is not in offer ${offerId} acceptable_collateral`);
            }
            throw new Error('Unable to determine acceptable collateral for credit offer');
        }

        const inferredCollateralAssetId = collateralAssetId
            || (collateralMap.size === 1 ? collateralMap.keys().next().value : null)
            || getPriceQuoteAssetId(collateralPrice);
        const collateralAsset = await this._resolveAsset(inferredCollateralAssetId);
        if (!collateralAsset) {
            throw new Error('Unable to resolve collateral asset metadata for credit offer');
        }

        let borrowInt: number | null = null;
        let requiredCollateralInt: number | null = null;
        const requestedBorrowAmount = borrowAmount !== undefined && borrowAmount !== null
            ? positiveOrNull(borrowAmount)
            : null;

        if (borrowAmount !== undefined && borrowAmount !== null && requestedBorrowAmount === null) {
            throw new Error('borrowAmount must be positive');
        }

        if (requestedBorrowAmount !== null) {
            borrowInt = floatToBlockchainInt(requestedBorrowAmount, debtAsset.precision);
            if (!Number.isFinite(borrowInt) || borrowInt <= 0) {
                throw new Error('borrowAmount must be positive');
            }
            this._enforceMaxBorrowAmount(policy, borrowInt, debtAsset, { pendingRepayAmount });

            const minimumCollateralInt = this._calculateRequiredCollateral(borrowInt, collateralPrice, debtAsset, collateralAsset);
            const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                ? await this._getCollateralPercentageBase(accountId, collateralAsset.id)
                : null;
            requiredCollateralInt = collateralSpec?.amount !== null && collateralSpec?.amount !== undefined
                ? await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'total', referenceAmount: collateralReferenceAmount, referenceLabel: 'total collateral balance' })
                : minimumCollateralInt;
            if (minimumCollateralInt != null && requiredCollateralInt != null && requiredCollateralInt < minimumCollateralInt) {
                throw new Error(`collateral amount ${requiredCollateralInt} is below required collateral ${minimumCollateralInt}`);
            }
        } else {
            const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                ? await this._getCollateralPercentageBase(accountId, collateralAsset.id)
                : null;
            requiredCollateralInt = await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'total', referenceAmount: collateralReferenceAmount, referenceLabel: 'total collateral balance' });
            borrowInt = this._calculateBorrowAmountFromCollateral(requiredCollateralInt, collateralPrice, debtAsset, collateralAsset);
            if (borrowInt != null && Number.isFinite(borrowInt) && borrowInt > 0) {
                this._enforceMaxBorrowAmount(policy, borrowInt, debtAsset, { pendingRepayAmount });
            }
        }

        // Enforce per-operation borrow limit
        const maxPerOp = positiveOrNull(policy?.maxBorrowAmountPerOperation);
        if (maxPerOp !== null && borrowInt != null && borrowInt > 0) {
            const borrowFloat = blockchainToFloat(borrowInt, debtAsset.precision);
            if (Number.isFinite(borrowFloat) && borrowFloat > maxPerOp) {
                throw new Error(`borrowAmount ${borrowFloat} exceeds maxBorrowAmountPerOperation ${maxPerOp}`);
            }
        }

        if (requiredCollateralInt == null || requiredCollateralInt <= 0) {
            throw new Error('Unable to determine collateral amount for credit offer');
        }

        if (borrowInt == null || borrowInt <= 0) {
            throw new Error('Unable to determine borrow amount from collateral amount');
        }

        await this._enforceMaxCollateralAmount(policy, requiredCollateralInt, collateralAsset, accountId, {
            pendingReleaseCollateralAmount,
        });

        const minDealAmount = toFiniteNumber(offerObj?.min_deal_amount, undefined);
        if (minDealAmount !== null && borrowInt < minDealAmount) {
            throw new Error(`borrowAmount ${borrowInt} is below min_deal_amount ${minDealAmount}`);
        }

        const maxFeeRatePerDayValue = positiveOrNull(policy.maxFeeRatePerDay) ?? this._getDefaultMaxFeeRatePerDay();
        const dailyRate = this._calculateDailyFeeRate(offerObj);
        if (dailyRate > maxFeeRatePerDayValue) {
            throw new Error(`offer daily fee rate ${dailyRate.toFixed(6)} exceeds maxFeeRatePerDay ${maxFeeRatePerDayValue}`);
        }

        const offerFeeRate = toFiniteNumber(offerObj?.fee_rate, 0) || 0;

        if (offerObj?.enabled === false) {
            throw new Error(`credit offer ${offerId} is disabled`);
        }

        const minDurationSeconds = positiveOrNull(policy.minDurationSeconds);
        const minDuration = minDurationSeconds !== null ? minDurationSeconds : 0;
        const policyCollateralAssetRef = policy.collateralAsset;
        if (policyCollateralAssetRef && collateralAsset?.id) {
            const policyCollateralAsset = await this._resolveAsset(policyCollateralAssetRef);
            if (policyCollateralAsset?.id && String(collateralAsset.id) !== String(policyCollateralAsset.id)) {
                throw new Error(`collateral asset ${collateralAsset.id} does not match policy.collateralAsset`);
            }
        }

        const maxCollateralRatioValue = positiveOrNull(policy.maxCollateralRatio);
        if (maxCollateralRatioValue === null) {
            throw new Error('creditOffer maxCollateralRatio is required');
        }

        const borrowAmountFloat = blockchainToFloat(borrowInt, debtAsset.precision);
        const collateralValueInDebtAsset: any = await this._calculateCollateralValueInDebtAsset(requiredCollateralInt, collateralAsset, debtAsset, collateralPrice);
        const offerCollateralValueInDebtAsset: number | null = this._calculateCreditOfferCollateralValueInDebtAsset(requiredCollateralInt, collateralAsset, debtAsset, collateralPrice);
        if (collateralValueInDebtAsset == null || offerCollateralValueInDebtAsset == null || borrowAmountFloat <= 0 || collateralValueInDebtAsset <= 0 || offerCollateralValueInDebtAsset <= 0) {
            throw new Error(collateralAsset?.for_liquidity_pool
                ? 'Unable to value liquidity pool collateral for credit offer'
                : 'Unable to determine collateral value for credit offer');
        }

        const collateralRatio = collateralAsset?.for_liquidity_pool
            ? collateralValueInDebtAsset / offerCollateralValueInDebtAsset
            : collateralValueInDebtAsset / borrowAmountFloat;
        if (collateralRatio > maxCollateralRatioValue) {
            throw new Error(`collateral ratio ${collateralRatio} exceeds maxCollateralRatio ${maxCollateralRatioValue}`);
        }

        const extensions: Record<string, any> = {};
        const autoRepayValue = resolveAutoRepayValue(autoRepay);
        if (autoRepayValue > 0) {
            extensions.auto_repay = autoRepayValue;
        }

        const op = {
            op_name: 'credit_offer_accept',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                borrower: accountId,
                offer_id: offerId,
                borrow_amount: toAmountObject(borrowInt, debtAsset.id),
                collateral: toAmountObject(requiredCollateralInt, collateralAsset.id),
                max_fee_rate: offerFeeRate,
                min_duration_seconds: minDuration,
                extensions,
            }
        };

        this.state.lastBorrowRequest = {
            offerId: String(offerId),
            borrowAmount: borrowInt,
            collateralAmount: requiredCollateralInt,
            autoReborrow: !!policy?.autoReborrow,
            requestedAt: new Date().toISOString()
        };

        return op;
    }

    _calculateRequiredCollateral(borrowAmountInt: any, collateralPrice: any, debtAsset: any = null, collateralAsset: any = null): number | null {
        const baseAmount = toFiniteNumber(collateralPrice?.base?.amount, undefined);
        const quoteAmount = toFiniteNumber(collateralPrice?.quote?.amount, undefined);
        if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }
        if (this._creditPriceOrientation(collateralPrice, debtAsset, collateralAsset) === 'legacy-reversed') {
            return Math.ceil((Number(borrowAmountInt) * baseAmount) / quoteAmount);
        }
        return Math.ceil((Number(borrowAmountInt) * quoteAmount) / baseAmount);
    }

    _calculateCreditFee(repayAmountInt: any, feeRate: any): number {
        const repay = BigInt(Math.max(0, Math.trunc(Number(repayAmountInt))));
        const rate = BigInt(Math.max(0, Math.trunc(Number(feeRate))));
        const denom = BigInt(CREDIT_FEE_RATE_DENOM);
        if (repay <= 0n || rate <= 0n) return 0;
        return Number(((repay * rate) + denom - 1n) / denom);
    }

    async buildCreditDealRepayOperation(deal: any, repayAmount: any): Promise<any> {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : null;
        if (!dealSummary) {
            throw new Error('credit deal is required');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit repay');
        }

        const debtAsset = await this._resolveAsset(dealSummary.debtAssetId);
        if (!debtAsset) {
            throw new Error('Unable to resolve debt asset metadata for credit repay');
        }

        const repayInt = floatToBlockchainInt(repayAmount, debtAsset.precision);
        if (!Number.isFinite(repayInt) || repayInt <= 0) {
            throw new Error('repayAmount must be positive');
        }
        if (repayInt > dealSummary.debtAmount) {
            throw new Error(`repayAmount ${repayInt} exceeds unpaid amount ${dealSummary.debtAmount}`);
        }

        const creditFee = this._calculateCreditFee(repayInt, dealSummary.feeRate);

        return {
            op_name: 'credit_deal_repay',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                account: accountId,
                deal_id: dealSummary.id,
                repay_amount: toAmountObject(repayInt, debtAsset.id),
                credit_fee: toAmountObject(creditFee, debtAsset.id),
                extensions: [] as any,
            }
        };
    }

    async buildCreditDealUpdateOperation(deal: any, autoRepay: any): Promise<any> {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : null;
        if (!dealSummary) {
            throw new Error('credit deal is required');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit deal update');
        }

        return {
            op_name: 'credit_deal_update',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                account: accountId,
                deal_id: dealSummary.id,
                auto_repay: resolveAutoRepayValue(autoRepay),
                extensions: [] as any,
            }
        };
    }

    async executeOperations(operations: any, reason: any = 'credit runtime'): Promise<any> {
        if (!Array.isArray(operations) || operations.length === 0) {
            return { skipped: true, reason: 'no operations', operations: [] };
        }

        if (this.bot?.config?.dryRun) {
            return { dryRun: true, reason, operations: deepClone(operations) };
        }

        const accountName = await this._resolveAccountName(getAccountRef(this.bot));
        if (!accountName) {
            throw new Error('Unable to resolve account name for broadcast');
        }
        if (!this.bot?.privateKey) {
            throw new Error('Missing signing key for credit runtime broadcast');
        }

        return chainOrders.executeBatch(accountName, this.bot.privateKey, operations);
    }

    async _checkGridMaintenanceAfterCreditUpdate(context: any = 'credit capital update', options: Record<string, any> = {}): Promise<any> {
        const manager = this.bot?.manager;
        if (!this.bot || !manager) {
            return { skipped: true, reason: 'grid maintenance unavailable' };
        }

        const accountId = this.bot?.accountId || this.bot?.account?.id || null;
        const lock = manager?._fillProcessingLock;
        const runCheck = async () => {
            if (typeof manager.fetchAccountTotals === 'function' && accountId) {
                await manager.fetchAccountTotals(accountId);
            }
            return this.bot._runGridMaintenance(context, {
                ...options,
            });
        };

        try {
            if (!lock || typeof lock.acquire !== 'function' || lock.isReentrant()) {
                return await runCheck();
            }
            return await lock.acquire(runCheck);
        } catch (err: any) {
            this.warn(`credit runtime: post-credit grid maintenance failed during ${context}: ${getErrorMessage(err)}`);
            return { skipped: false, error: getErrorMessage(err) };
        }
    }

    async openCreditPosition({ offer, borrowAmount, collateralAmount, autoRepay = false, reason = 'credit borrow' }: any = {}): Promise<any> {
        const offerObj = typeof offer === 'object' ? offer : await this._getOfferById(offer);
        let resolvedCollateral = collateralAmount;
        if (resolvedCollateral !== null && resolvedCollateral !== undefined && offerObj) {
            const isBare = typeof resolvedCollateral === 'number'
                || (typeof resolvedCollateral === 'object' && resolvedCollateral.assetId == null);
            if (isBare) {
                const collateralMap = normalizeCollateralMap(offerObj.acceptable_collateral);
                if (collateralMap.size === 1) {
                    const amountVal = typeof resolvedCollateral === 'number'
                        ? resolvedCollateral
                        : (resolvedCollateral.amount ?? null);
                    resolvedCollateral = { amount: amountVal, assetId: collateralMap.keys().next().value };
                }
            }
        }
        const acceptOp = await this.buildCreditOfferAcceptOperation({
            offer: offerObj,
            borrowAmount,
            collateralAmount: resolvedCollateral,
            autoRepay,
        });
        const result = await this.executeOperations([acceptOp], reason);
        await this.refreshState();
        await this._checkGridMaintenanceAfterCreditUpdate('credit capital update');
        await this.persistState(reason);
        return result;
    }

    async repayCreditDeal(deal: any, repayAmount: any, options: Record<string, any> = {}): Promise<any> {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : await this._getDealById(deal);
        if (!dealSummary) {
            throw new Error('credit deal not found');
        }

        const repayOp = await this.buildCreditDealRepayOperation(dealSummary, repayAmount);
        const operations: any[] = [repayOp];
        const reborrowPolicy = options.specificPolicy || await this._findLendingItemForAsset(dealSummary.debtAssetId, 'creditOffer') || {};
        let shouldAutoReborrow = options.autoReborrow !== false && !!reborrowPolicy.autoReborrow;
        if (shouldAutoReborrow) {
            const disallowedDealIds = this._normalizePolicyList(reborrowPolicy.disallowedDealIds);
            if (disallowedDealIds.length > 0 && dealSummary.id && disallowedDealIds.includes(String(dealSummary.id))) {
                shouldAutoReborrow = false;
            }
        }
        let deferredReborrowRequest: any = null;
        let inlineReborrowPlanned = false;

        if (shouldAutoReborrow) {
            const reborrowAmount = options.reborrowAmount !== undefined && options.reborrowAmount !== null
                ? options.reborrowAmount
                : repayAmount;
            let reborrowCollateralAmount = options.collateralAmount !== undefined
                ? options.collateralAmount
                : null;
            if (reborrowCollateralAmount !== null && dealSummary.collateralAssetId) {
                const isBare = typeof reborrowCollateralAmount === 'number'
                    || (typeof reborrowCollateralAmount === 'object' && reborrowCollateralAmount.assetId == null);
                if (isBare) {
                    const amountVal = typeof reborrowCollateralAmount === 'number'
                        ? reborrowCollateralAmount
                        : (reborrowCollateralAmount.amount ?? null);
                    reborrowCollateralAmount = { amount: amountVal, assetId: dealSummary.collateralAssetId };
                }
            }
            let effectiveCollateralAssetId = dealSummary.collateralAssetId;
            if (options.collateralAsset && dealSummary.collateralAssetId) {
                const overrideId = typeof options.collateralAsset === 'object'
                    ? (options.collateralAsset.id ?? options.collateralAsset.asset_id ?? null)
                    : options.collateralAsset;
                if (overrideId && String(overrideId) !== String(dealSummary.collateralAssetId)) {
                    const amountVal = reborrowCollateralAmount === null
                        ? null
                        : (typeof reborrowCollateralAmount === 'number'
                            ? reborrowCollateralAmount
                            : (reborrowCollateralAmount.amount ?? null));
                    reborrowCollateralAmount = { amount: amountVal, assetId: overrideId };
                    effectiveCollateralAssetId = overrideId;
                }
            }
            const policyHasAutoRepay = Object.prototype.hasOwnProperty.call(reborrowPolicy, 'autoRepay');
            const autoRepaySetting = options.autoRepay !== undefined
                ? options.autoRepay
                : (policyHasAutoRepay ? reborrowPolicy.autoRepay : (dealSummary.autoRepay ?? false));
            const offer = await this._getOfferById(dealSummary.offerId);
            if (offer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: autoRepaySetting,
                        specificPolicy: options.specificPolicy,
                        pendingRepayAmount: repayAmount,
                        pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                    });
                    operations.push(acceptOp);
                    inlineReborrowPlanned = true;
                } catch (err: any) {
                    const fallback = await this._selectFallbackCreditOffer({
                        debtAssetId: dealSummary.debtAssetId,
                        collateralAssetId: effectiveCollateralAssetId,
                        policy: reborrowPolicy,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: autoRepaySetting,
                        pendingRepayAmount: repayAmount,
                        pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                        excludeOfferId: dealSummary.offerId,
                    });
                    if (fallback) {
                        this.warn(`credit runtime: fallback reborrow offer ${fallback.offer.id} selected after original offer ${dealSummary.offerId} failed: ${getErrorMessage(err)}`);
                        operations.push(fallback.op);
                        inlineReborrowPlanned = true;
                    } else {
                        deferredReborrowRequest = {
                            sourceDealId: dealSummary.id,
                            offerId: dealSummary.offerId,
                            borrowAmount: reborrowAmount,
                            collateralAmount: reborrowCollateralAmount,
                            autoRepay: autoRepaySetting,
                            specificPolicy: reborrowPolicy,
                            pendingRepayAmount: repayAmount,
                            pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                            requestedAt: new Date().toISOString(),
                            reason: getErrorMessage(err),
                        };
                    }
                }
            } else {
                const fallback = await this._selectFallbackCreditOffer({
                    debtAssetId: dealSummary.debtAssetId,
                    collateralAssetId: effectiveCollateralAssetId,
                    policy: reborrowPolicy,
                    borrowAmount: reborrowAmount,
                    collateralAmount: reborrowCollateralAmount,
                    autoRepay: autoRepaySetting,
                    pendingRepayAmount: repayAmount,
                    pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                    excludeOfferId: dealSummary.offerId,
                });
                if (fallback) {
                    this.warn(`credit runtime: fallback reborrow offer ${fallback.offer.id} selected because original offer ${dealSummary.offerId} is unavailable`);
                    operations.push(fallback.op);
                    inlineReborrowPlanned = true;
                } else {
                    deferredReborrowRequest = {
                        sourceDealId: dealSummary.id,
                        offerId: dealSummary.offerId,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: autoRepaySetting,
                        specificPolicy: reborrowPolicy,
                        pendingRepayAmount: repayAmount,
                        pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                        requestedAt: new Date().toISOString(),
                        reason: 'offer unavailable',
                    };
                }
            }
        }

        const result = await this.executeOperations(operations, 'credit repay');
        this.state.lastRepayAt = new Date().toISOString();
        const onChainDeals = await this._fetchBorrowerDeals();
        const sourceDealStillActive = onChainDeals.some((entry) => String(entry?.id) === String(dealSummary.id));
        await this.refreshState();
        if (shouldAutoReborrow && !inlineReborrowPlanned && !sourceDealStillActive) {
            const reborrowOffer = await this._getOfferById(dealSummary.offerId);
            const reborrowRequest: any = deferredReborrowRequest || {
                sourceDealId: dealSummary.id,
                offerId: dealSummary.offerId,
                borrowAmount: options.reborrowAmount !== undefined && options.reborrowAmount !== null
                    ? options.reborrowAmount
                    : repayAmount,
                collateralAmount: options.collateralAmount !== undefined ? options.collateralAmount : null,
                autoRepay: options.autoRepay !== undefined
                    ? options.autoRepay
                    : (Object.prototype.hasOwnProperty.call(reborrowPolicy, 'autoRepay')
                        ? reborrowPolicy.autoRepay
                        : (dealSummary.autoRepay ?? false)),
                specificPolicy: reborrowPolicy,
                pendingRepayAmount: repayAmount,
                pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                requestedAt: new Date().toISOString(),
                reason: deferredReborrowRequest?.reason || null,
            };
            if (reborrowOffer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer: reborrowOffer,
                        borrowAmount: reborrowRequest.borrowAmount,
                        collateralAmount: reborrowRequest.collateralAmount,
                        autoRepay: reborrowRequest.autoRepay,
                        specificPolicy: reborrowRequest.specificPolicy,
                        pendingReleaseCollateralAmount: reborrowRequest.pendingReleaseCollateralAmount,
                    });
                    await this.executeOperations([acceptOp], 'credit reborrow');
                    await this.refreshState();
                    deferredReborrowRequest = null;
                } catch (err: any) {
                    this.queueReborrow({
                        ...reborrowRequest,
                        reason: getErrorMessage(err),
                    });
                }
            } else {
                this.queueReborrow({
                    ...reborrowRequest,
                    reason: 'offer unavailable',
                });
            }
        } else if (shouldAutoReborrow && deferredReborrowRequest && !inlineReborrowPlanned && !sourceDealStillActive) {
            this.queueReborrow(deferredReborrowRequest);
        } else if (shouldAutoReborrow && deferredReborrowRequest && !inlineReborrowPlanned && sourceDealStillActive) {
            this.warn(`credit runtime: deferred reborrow for deal ${dealSummary.id} dropped — source deal still active on-chain after repay`);
        }
        await this._checkGridMaintenanceAfterCreditUpdate('credit capital update');
        await this.persistState('credit repay');
        return result;
    }

    queueReborrow(request: any): void {
        if (!request || typeof request !== 'object') return;
        this.state.pendingReborrows = Array.isArray(this.state.pendingReborrows) ? this.state.pendingReborrows : [];
        this.state.pendingReborrows.push({
            sourceDealId: request.sourceDealId || null,
            offerId: request.offerId || null,
            borrowAmount: request.borrowAmount ?? null,
            collateralAmount: request.collateralAmount ?? null,
            autoRepay: request.autoRepay ?? false,
            specificPolicy: request.specificPolicy || null,
            pendingRepayAmount: request.pendingRepayAmount ?? null,
            pendingReleaseCollateralAmount: request.pendingReleaseCollateralAmount ?? null,
            requestedAt: request.requestedAt || new Date().toISOString(),
            reason: request.reason || null,
        });
        this.state.reborrowPending = this.state.pendingReborrows.length > 0;
    }

    _extractDealNumericId(id: any): number {
        if (!id) return 0;
        const parts = String(id).split('.');
        const num = Number(parts[parts.length - 1]);
        return Number.isFinite(num) ? num : 0;
    }

    async _getOfferById(offerId: any): Promise<any> {
        if (!offerId) return null;
        const cacheKey = `offer:${offerId}`;
        const cached = this._objectCache.get(cacheKey);
        if (cached) {
            // Check TTL: re-fetch from chain if the cached offer is too old.
            // Offers rarely change their min_deal_amount, so a moderate TTL
            // (OFFER_CACHE_TTL_MS, default 10min) balances freshness with RPC
            // load. Without this guard, a stale cached min_deal_amount could
            // cause deal-split guards to pass against a value that no longer
            // holds on-chain.
            const OFFER_CACHE_TTL_MS = require('./constants').TIMING.OFFER_CACHE_TTL_MS;
            const cachedAt = cached._cachedAt || 0;
            if (Date.now() - cachedAt < OFFER_CACHE_TTL_MS) {
                return cached;
            }
            // Expired: fall through to re-fetch
            this._objectCache.delete(cacheKey);
        }
        const objects = await this._dbCall('get_objects', [[offerId]]);
        const offer = Array.isArray(objects) ? objects[0] : null;
        if (offer) {
            this._objectCache.set(cacheKey, { ...offer, _cachedAt: Date.now() });
        }
        return offer;
    }

    async _fetchCreditOffersByAsset(assetId: any): Promise<any[]> {
        if (!assetId) return [];
        try {
            const limit = 100;
            const offers: any[] = [];
            const seen = new Set();
            let startId: string | null = null;
            for (let pageCount = 0; pageCount < 50; pageCount++) {
                const args = startId ? [assetId, limit, startId] : [assetId, limit];
                const page = await this._dbCall('get_credit_offers_by_asset', args);
                if (!Array.isArray(page) || page.length === 0) break;
                let added = 0;
                for (const offer of page) {
                    if (!offer?.id || seen.has(String(offer.id))) continue;
                    seen.add(String(offer.id));
                    offers.push(offer);
                    added++;
                }
                const lastId = page[page.length - 1]?.id;
                if (!lastId || page.length < limit || added === 0) break;
                startId = lastId;
            }
            return offers;
        } catch (err: any) {
            this.warn(`credit runtime: unable to fetch fallback credit offers for ${assetId}: ${getErrorMessage(err)}`);
            return [];
        }
    }

    async _resolveFallbackAssetIds(policy: any, offer: any = null): Promise<any> {
        const debtAsset = offer?.asset_type
            ? await this._resolveAsset(offer.asset_type)
            : await this._resolveAsset(policy?.asset);
        const collateralAsset = policy?.collateralAsset
            ? await this._resolveAsset(policy.collateralAsset)
            : null;
        return {
            debtAssetId: debtAsset?.id ? String(debtAsset.id) : null,
            collateralAssetId: collateralAsset?.id ? String(collateralAsset.id) : null,
        };
    }

    async _selectFallbackCreditOffer({ debtAssetId, collateralAssetId, policy, borrowAmount, collateralAmount, autoRepay, pendingRepayAmount = null, pendingReleaseCollateralAmount, excludeOfferId = null }: { debtAssetId?: any; collateralAssetId?: any; policy?: any; borrowAmount?: any; collateralAmount?: any; autoRepay?: any; pendingRepayAmount?: any; pendingReleaseCollateralAmount?: any; excludeOfferId?: any; } = {}): Promise<any> {
        const offers = await this._fetchCreditOffersByAsset(debtAssetId);
        const candidates: any[] = [];
        for (const offer of offers) {
            if (!offer?.id) continue;
            if (excludeOfferId && String(offer.id) === String(excludeOfferId)) continue;
            if (String(offer.asset_type) !== String(debtAssetId)) continue;
            if (offer.enabled === false) continue;
            const collateralMap = normalizeCollateralMap(offer.acceptable_collateral);
            if (!collateralMap.has(String(collateralAssetId))) continue;
            const validation = this._validateCreditPolicy(policy, offer);
            if (!validation.allow) continue;
            try {
                const op = await this.buildCreditOfferAcceptOperation({
                    offer,
                    borrowAmount,
                    collateralAmount,
                    autoRepay,
                    specificPolicy: policy,
                    pendingRepayAmount,
                    pendingReleaseCollateralAmount,
                });
                candidates.push({
                    offer,
                    op,
                    dailyRate: this._calculateDailyFeeRate(offer),
                    feeRate: toFiniteNumber(offer.fee_rate, Number.MAX_SAFE_INTEGER),
                    balance: toFiniteNumber(offer.current_balance, 0),
                    duration: toFiniteNumber(offer.max_duration_seconds, 0),
                });
            } catch (_: any) {
                // Candidate does not satisfy amount, ratio, balance, or duration policy.
            }
        }

        candidates.sort((a, b) => (
            a.dailyRate - b.dailyRate
            || a.feeRate - b.feeRate
            || b.duration - a.duration
            || b.balance - a.balance
            || String(a.offer.id).localeCompare(String(b.offer.id))
        ));
        return candidates[0] || null;
    }

    async _selectCreditOfferForIncrease({ debtAssetId, collateralAssetId, policy, collateralAmount, minCollateralIncrease = 0, remainingBorrowCapacity = null, autoRepay }: { debtAssetId?: any; collateralAssetId?: any; policy?: any; collateralAmount?: any; minCollateralIncrease?: number; remainingBorrowCapacity?: any; autoRepay?: any; } = {}): Promise<any> {
        const allowedOfferIds = this._normalizePolicyList(policy?.allowedOfferIds);
        const offers: any[] = [];
        const seen = new Set();
        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        const finiteRemainingBorrowCapacity = Number.isFinite(Number(remainingBorrowCapacity)) && Number(remainingBorrowCapacity) > 0
            ? Number(remainingBorrowCapacity)
            : null;

        // Apply per-operation borrow limit on top of remaining capacity
        const maxPerOp = positiveOrNull(policy?.maxBorrowAmountPerOperation);
        const effectiveBorrowCapacity = finiteRemainingBorrowCapacity !== null && maxPerOp !== null
            ? Math.min(finiteRemainingBorrowCapacity, maxPerOp)
            : finiteRemainingBorrowCapacity ?? maxPerOp;

        for (const offerId of allowedOfferIds) {
            const offer = await this._getOfferById(offerId);
            if (offer?.id && !seen.has(String(offer.id))) {
                seen.add(String(offer.id));
                offers.push(offer);
            }
        }

        if (offers.length === 0) {
            for (const offer of await this._fetchCreditOffersByAsset(debtAssetId)) {
                if (offer?.id && !seen.has(String(offer.id))) {
                    seen.add(String(offer.id));
                    offers.push(offer);
                }
            }
        }

        const candidates: any[] = [];
        for (const offer of offers) {
            if (!offer?.id) continue;
            if (String(offer.asset_type) !== String(debtAssetId)) continue;
            if (offer.enabled === false) continue;
            const collateralMap = normalizeCollateralMap(offer.acceptable_collateral);
            if (!collateralMap.has(String(collateralAssetId))) continue;
            const collateralPrice = collateralMap.get(String(collateralAssetId));
            const validation = this._validateCreditPolicy(policy, offer);
            if (!validation.allow) continue;
            try {
                let acceptArgs: any = {
                    offer,
                    collateralAmount,
                    autoRepay,
                    specificPolicy: policy,
                };
                if (accountId && debtAsset && collateralAsset && effectiveBorrowCapacity !== null) {
                    const collateralSpec = normalizeAmountSpec(collateralAmount);
                    const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                        ? await this._getCollateralPercentageBase(accountId, collateralAsset.id)
                        : null;
                    const requestedCollateralInt = await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, {
                        balanceField: 'total',
                        referenceAmount: collateralReferenceAmount,
                        referenceLabel: 'total collateral balance',
                    });
                    const desiredBorrowInt = this._calculateBorrowAmountFromCollateral(
                        requestedCollateralInt,
                        collateralPrice,
                        debtAsset,
                        collateralAsset
                    );
                    const desiredBorrowAmount = blockchainToFloat(desiredBorrowInt, debtAsset.precision);
                    if (Number.isFinite(desiredBorrowAmount) && desiredBorrowAmount > effectiveBorrowCapacity) {
                        acceptArgs = {
                            offer,
                            borrowAmount: effectiveBorrowCapacity,
                            collateralAmount: { assetId: collateralAsset.id },
                            autoRepay,
                            specificPolicy: policy,
                        };
                    }
                }

                let op: any = null;
                try {
                    op = await this.buildCreditOfferAcceptOperation(acceptArgs);
                } catch (err: any) {
                    if (!isMaxBorrowAmountError(err)) {
                        throw err;
                    }
                    if (effectiveBorrowCapacity === null) {
                        throw err;
                    }
                    op = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: effectiveBorrowCapacity,
                        collateralAmount: { assetId: collateralAssetId },
                        autoRepay,
                        specificPolicy: policy,
                    });
                }
                const opBorrowAmount = blockchainAmountToFloat(op?.op_data?.borrow_amount, await this._resolveAsset(debtAssetId));
                const opCollateralAmount = blockchainAmountToFloat(op?.op_data?.collateral, await this._resolveAsset(collateralAssetId));
                if (opBorrowAmount == null || opCollateralAmount == null || opBorrowAmount <= 0 || opCollateralAmount <= 0) {
                    continue;
                }
                const capped = opCollateralAmount < toFiniteNumber(collateralAmount?.amount ?? collateralAmount, 0);
                if (capped && opCollateralAmount < minCollateralIncrease) {
                    continue;
                }
                candidates.push({
                    offer,
                    op,
                    borrowAmount: opBorrowAmount,
                    collateralAmount: opCollateralAmount,
                    capped,
                    dailyRate: this._calculateDailyFeeRate(offer),
                    feeRate: toFiniteNumber(offer.fee_rate, Number.MAX_SAFE_INTEGER),
                    balance: toFiniteNumber(offer.current_balance, 0),
                    duration: toFiniteNumber(offer.max_duration_seconds, 0),
                });
            } catch (_: any) {
                // Candidate does not satisfy amount, ratio, balance, or duration policy.
            }
        }

        candidates.sort((a, b) => (
            a.dailyRate - b.dailyRate
            || a.feeRate - b.feeRate
            || b.duration - a.duration
            || b.balance - a.balance
            || String(a.offer.id).localeCompare(String(b.offer.id))
        ));
        return candidates[0] || null;
    }

    async _buildCreditIncreasePlan(lendingItem: any, assetId: any, posState: any): Promise<any> {
        if (!Object.prototype.hasOwnProperty.call(lendingItem, 'minCollateralIncreaseThreshold')) return null;
        const assignedCollateralBudget = positiveOrNull(posState?.assignedCollateralBudget);
        if (assignedCollateralBudget === null) return null;
        const minCollateralIncrease = resolveMinCollateralIncreaseThreshold(
            lendingItem.minCollateralIncreaseThreshold,
            assignedCollateralBudget
        );
        if (minCollateralIncrease === null) return null;

        const debtAsset = await this._resolveAsset(assetId);
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        if (!debtAsset || !collateralAsset) return null;

        const currentDebtAmount = (posState.creditDeals || []).reduce((sum: any, deal: any) => {
            return sum + (blockchainAmountToFloat(deal?.debtAmount, debtAsset) || 0);
        }, 0);
        const currentCollateralAmount = (posState.creditDeals || []).reduce((sum: any, deal: any) => {
            return sum + (blockchainAmountToFloat(deal?.collateralAmount, collateralAsset) || 0);
        }, 0);

        const collateralIncreaseAmount = assignedCollateralBudget - currentCollateralAmount;
        if (
            !Number.isFinite(collateralIncreaseAmount)
            || collateralIncreaseAmount <= 0
            || collateralIncreaseAmount < minCollateralIncrease
        ) {
            return null;
        }

        const maxBorrowAmount = positiveOrNull(lendingItem.maxBorrowAmount);
        const remainingBorrowCapacity = maxBorrowAmount !== null
            ? maxBorrowAmount - currentDebtAmount
            : null;
        if (remainingBorrowCapacity !== null && remainingBorrowCapacity <= 0) {
            return null;
        }

        return {
            action: 'increase_credit_debt',
            currentCollateralAmount: roundToDecimals(currentCollateralAmount, 8),
            collateralIncreaseAmount: roundToDecimals(collateralIncreaseAmount, 8),
            minCollateralIncrease: roundToDecimals(minCollateralIncrease, 8),
            currentDebtAmount: roundToDecimals(currentDebtAmount, 8),
            maxBorrowAmount: maxBorrowAmount !== null ? roundToDecimals(maxBorrowAmount, 8) : null,
            remainingBorrowCapacity: remainingBorrowCapacity !== null ? roundToDecimals(remainingBorrowCapacity, 8) : null,
            assignedCollateralBudget: roundToDecimals(assignedCollateralBudget, 8),
        };
    }

    async _splitOversizedCreditDeals(lendingItem: any, assetId: any, posState: any, runtimeContext: Record<string, any> = {}): Promise<any> {
        const maxPerOp = positiveOrNull(lendingItem.maxBorrowAmountPerOperation);
        if (maxPerOp === null) return null;

        // T2: Concurrency guard — prevent concurrent splits from runMaintenance / watchdog
        if (this._splitInFlight) return { skipped: true, reason: 'split in flight' };
        this._splitInFlight = true;
        try {
            return await this._doSplitOversizedCreditDeals(lendingItem, assetId, posState, runtimeContext);
        } finally {
            this._splitInFlight = false;
        }
    }

    async _doSplitOversizedCreditDeals(lendingItem: any, assetId: any, posState: any, _runtimeContext: Record<string, any> = {}): Promise<any> {
        const maxPerOp = positiveOrNull(lendingItem.maxBorrowAmountPerOperation);
        if (maxPerOp === null) return null;

        const debtAsset = await this._resolveAsset(assetId);
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        if (!debtAsset || !collateralAsset) return null;

        const deals = Array.isArray(posState?.creditDeals) ? posState.creditDeals : [];
        const oversized = deals.filter((d: any) => {
            const debt = blockchainAmountToFloat(d?.debtAmount, debtAsset);
            return debt != null && debt > maxPerOp;
        });
        if (oversized.length === 0) return null;

        // T3: Use canonical settle-delay resolution matching dexbot_maintenance_runtime.ts
        const settleDelay = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
            ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
            : 6_000;

        // T4: Hard cap on pieces per cycle so the watchdog interval is never exceeded
        const MAX_PIECES_PER_CYCLE = Number.isFinite(TIMING.CREDIT_DEAL_SPLIT_MAX_PIECES)
            ? Math.max(0, TIMING.CREDIT_DEAL_SPLIT_MAX_PIECES)
            : 48;

        const configuredCollateralAssetId = collateralAsset.id;
        const posKey = configuredCollateralAssetId
            ? this._positionKey(assetId, configuredCollateralAssetId)
            : assetId;
        let prevPieceAt = 0;
        let totalPiecesThisCycle = 0;

        for (const deal of oversized) {
            const dealId = String(deal.id);
            let currentDeal = deal;

            const dealDebt = blockchainAmountToFloat(currentDeal.debtAmount, debtAsset);
            if (dealDebt == null || dealDebt <= maxPerOp) continue;

            // Check min_deal_amount on the offer to avoid reborrows that would fail.
            // Note: _getOfferById caches the offer for the runtime lifetime — if the
            // offer's min_deal_amount changes on-chain mid-split, the guard uses the
            // stale cached value. Risk is low in practice (offers rarely change this).
            const dealOffer = await this._getOfferById(parseDealSummary(currentDeal)?.offerId);
            const minDealAmount = toFiniteNumber(dealOffer?.min_deal_amount, undefined);
            const numPieces = Math.ceil((dealDebt as number) / maxPerOp);
            const pieceAmount = roundToDecimals((dealDebt as number) / numPieces, debtAsset.precision);
            if (minDealAmount !== null && pieceAmount < blockchainToFloat(minDealAmount, debtAsset.precision)) {
                this.warn(`credit runtime: cannot split deal ${dealId} — piece amount ${pieceAmount} below min_deal_amount ${blockchainToFloat(minDealAmount, debtAsset.precision)} for offer ${dealOffer?.id}`);
                continue;
            }

            const dealPieces = Math.min(numPieces - 1, MAX_PIECES_PER_CYCLE - totalPiecesThisCycle);
            if (dealPieces <= 0) {
                const remainingDeals = oversized.length - oversized.indexOf(deal) - 1;
                this.warn(`credit runtime: hit cap (${MAX_PIECES_PER_CYCLE}); deferring deal ${dealId} and ${remainingDeals} other deal(s)`);
                break;
            }
            if (dealPieces < numPieces - 1) {
                this.warn(`credit runtime: splitting only ${dealPieces} of ${numPieces - 1} pieces for deal ${dealId} this cycle (cap: ${MAX_PIECES_PER_CYCLE})`);
            }

            for (let i = 0; i < dealPieces; i++) {
                // T1: Abort on shutdown during settle delay
                if (prevPieceAt > 0) {
                    await new Promise((resolve, reject) => {
                        const t = setTimeout(resolve, settleDelay);
                        if (this.bot?._shuttingDown) {
                            clearTimeout(t);
                            reject(new Error('shutting down'));
                        }
                    });
                }

                // Re-fetch deal from current state (may have been refreshed by repayCreditDeal)
                const pos = this.state.positions?.[posKey];
                const refreshed = Array.isArray(pos?.creditDeals)
                    ? pos.creditDeals.find((d: any) => String(d.id) === dealId)
                    : null;
                if (!refreshed) {
                    this.warn(`credit runtime: deal ${dealId} (asset ${assetId}) vanished during restructure`);
                    break;
                }
                currentDeal = refreshed;

                const remaining = blockchainAmountToFloat(currentDeal.debtAmount, debtAsset);
                if (remaining == null || remaining <= maxPerOp) break;

                const currentPiece = Math.min(pieceAmount, remaining - maxPerOp);
                if (currentPiece <= 0) break;

                this.log(`credit runtime: splitting deal ${dealId}: repaying ${currentPiece} of ${remaining} debt (piece ${i + 1}/${dealPieces})`);

                await this.repayCreditDeal(currentDeal, currentPiece, {
                    autoReborrow: true,
                    specificPolicy: lendingItem,
                });

                prevPieceAt = Date.now();
                totalPiecesThisCycle++;
            }
        }

        if (prevPieceAt > 0) {
            // N3: skip heavy refresh on cap-exit — repayCreditDeal already called refreshState
            if (totalPiecesThisCycle < MAX_PIECES_PER_CYCLE) {
                await this.refreshCreditState({}, lendingItem);
            }
            const gridResult = await this._checkGridMaintenanceAfterCreditUpdate('credit restructure');
            return { action: 'restructured', gridMaintenanceResult: gridResult };
        }
        return null;
    }

    async _getDealById(dealId: any): Promise<any> {
        if (!dealId) return null;
        const deals = Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [];
        const fromState = deals.find((entry: any) => String(entry.id) === String(dealId));
        if (fromState) return fromState;
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return null;
        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const dealObjects = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        const normalized = Array.isArray(dealObjects) ? dealObjects.map(parseDealSummary).filter(Boolean) : [];
        return normalized.find((entry) => String(entry.id) === String(dealId)) || null;
    }

    async processPendingReborrows(): Promise<any> {
        if (!Array.isArray(this.state.pendingReborrows) || this.state.pendingReborrows.length === 0) {
            return { processed: 0, remaining: 0 };
        }
        if (this._reborrowsInFlight) {
            return { skipped: true, reason: 'reborrow processing already in flight' };
        }
        this._reborrowsInFlight = true;

        try {
            const onChainDeals = await this._fetchBorrowerDeals();
            const activeDealIds = new Set(onChainDeals.map((deal) => String(deal?.id)).filter(Boolean));
            const nextQueue: any[] = [];
            let processed = 0;

            for (const request of this.state.pendingReborrows) {
                if (!request?.offerId || (request.borrowAmount == null && request.collateralAmount == null)) {
                    this.warn(`credit runtime: dropping invalid pending reborrow request${request?.sourceDealId ? ` for deal ${request.sourceDealId}` : ''} — missing offerId or borrow/collateral amounts`);
                    continue;
                }

                const offer = await this._getOfferById(request.offerId);
                const requestPolicy = request.specificPolicy || (offer ? await this._resolveLendingPolicyForOffer(offer) : null);
                if (!requestPolicy || !requestPolicy.autoReborrow) {
                    this.warn(`credit runtime: dropping pending reborrow for offer ${request.offerId}; autoReborrow disabled or policy missing`);
                    continue;
                }

                if (request.sourceDealId && requestPolicy) {
                    const disallowedDealIds = this._normalizePolicyList(requestPolicy.disallowedDealIds);
                    if (disallowedDealIds.length > 0 && disallowedDealIds.includes(String(request.sourceDealId))) {
                        this.warn(`credit runtime: dropping pending reborrow for deal ${request.sourceDealId} — deal excluded by disallowedDealIds`);
                        continue;
                    }
                }

                if (request.sourceDealId && activeDealIds.has(String(request.sourceDealId))) {
                    this.warn(`credit runtime: pending reborrow for deal ${request.sourceDealId} deferred — source deal still active on-chain`);
                    nextQueue.push({ ...request, reason: 'source deal still active on-chain' });
                    continue;
                }

                // If the source deal is gone but a replacement deal from the same
                // offer already exists (higher deal ID, same offer), this pending
                // request is stale — the reborrow was already handled elsewhere.
                if (request.sourceDealId && request.offerId && requestPolicy?.renewOnly === true) {
                    const sourceNum = this._extractDealNumericId(request.sourceDealId);
                    if (sourceNum > 0) {
                        const hasNewerReplacement = onChainDeals.some((d) =>
                            String(d?.offerId) === String(request.offerId)
                            && this._extractDealNumericId(d.id) > sourceNum
                        );
                        if (hasNewerReplacement) {
                            this.warn(`credit runtime: dropping stale pending reborrow for deal ${request.sourceDealId} — replacement deal already exists for offer ${request.offerId}`);
                            processed++;
                            continue;
                        }
                    }
                }

                let effectiveCollateralAmount = request.collateralAmount ?? null;
                if (effectiveCollateralAmount !== null && requestPolicy?.collateralAsset) {
                    const isBare = typeof effectiveCollateralAmount === 'number'
                        || (typeof effectiveCollateralAmount === 'object' && effectiveCollateralAmount.assetId == null);
                    if (isBare) {
                        const colAsset = await this._resolveAsset(requestPolicy.collateralAsset);
                        if (colAsset?.id) {
                            const amountVal = typeof effectiveCollateralAmount === 'number'
                                ? effectiveCollateralAmount
                                : (effectiveCollateralAmount.amount ?? null);
                            effectiveCollateralAmount = { amount: amountVal, assetId: colAsset.id };
                        }
                    }
                }

                if (!offer || offer.enabled === false) {
                    const fallbackIds = await this._resolveFallbackAssetIds(requestPolicy, offer);
                    const fallback = fallbackIds.debtAssetId && fallbackIds.collateralAssetId
                        ? await this._selectFallbackCreditOffer({
                            debtAssetId: fallbackIds.debtAssetId,
                            collateralAssetId: fallbackIds.collateralAssetId,
                            policy: requestPolicy,
                            borrowAmount: request.borrowAmount,
                            collateralAmount: effectiveCollateralAmount,
                            autoRepay: request.autoRepay ?? false,
                            pendingRepayAmount: request.pendingRepayAmount ?? null,
                            pendingReleaseCollateralAmount: request.pendingReleaseCollateralAmount,
                            excludeOfferId: request.offerId,
                        })
                        : null;
                    if (fallback) {
                        try {
                            this.warn(`credit runtime: fallback reborrow offer ${fallback.offer.id} selected for pending request after offer ${request.offerId} became unavailable`);
                            await this.executeOperations([fallback.op], 'credit reborrow');
                            processed++;
                        } catch (err: any) {
                            this.warn(`credit runtime: fallback reborrow for offer ${request.offerId} failed: ${getErrorMessage(err)}`);
                            nextQueue.push({ ...request, reason: getErrorMessage(err) });
                        }
                    } else {
                        this.warn(`credit runtime: pending reborrow for offer ${request.offerId} deferred — ${offer ? 'offer disabled' : 'offer unavailable'}`);
                        nextQueue.push({ ...request, reason: offer ? 'offer disabled' : 'offer unavailable' });
                    }
                    continue;
                }

                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: request.borrowAmount ?? null,
                        collateralAmount: effectiveCollateralAmount,
                        autoRepay: request.autoRepay ?? false,
                        specificPolicy: request.specificPolicy || requestPolicy,
                        pendingRepayAmount: request.pendingRepayAmount ?? null,
                        pendingReleaseCollateralAmount: request.pendingReleaseCollateralAmount,
                    });
                    await this.executeOperations([acceptOp], 'credit reborrow');
                    processed++;
                } catch (err: any) {
                    this.warn(`credit runtime: pending reborrow for offer ${request.offerId} failed: ${getErrorMessage(err)}`);
                    nextQueue.push({ ...request, reason: getErrorMessage(err) });
                }
            }

            this.state.pendingReborrows = nextQueue;
            this.state.reborrowPending = nextQueue.length > 0;
            await this.refreshState();
            let gridMaintenanceResult = null;
            if (processed > 0) {
                gridMaintenanceResult = await this._checkGridMaintenanceAfterCreditUpdate('credit capital update');
            }
            await this.persistState('pending reborrows');

            return { processed, remaining: nextQueue.length, gridMaintenanceResult };
        } finally {
            this._reborrowsInFlight = false;
        }
    }

    async _runMpaMaintenance(context: any, _options: Record<string, any>, lendingItem: any, assetId: any): Promise<any> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_runMpaMaintenance requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_runMpaMaintenance requires an assetId');
        }

        const plan = await this._buildMpaPlanFromState(lendingItem, assetId);
        if (plan?.blocked) {
            return { blocked: true, reason: plan.reason };
        }
        if (!plan) {
            return null;
        }

        const executed: { leg: string; operation: any; result: any; }[] = [];
        let result: any = null;

        // Efficient path: Try combined operation first
        const combinedOp = await this.buildMpaUpdateOperation(plan, { leg: 'combined' }, lendingItem, assetId);
        if (combinedOp) {
            try {
                result = await this.executeOperations([combinedOp], `mpa maintenance:${context} combined`);
                executed.push({ leg: 'combined', operation: combinedOp, result });
                await this.refreshMpaState(lendingItem);
            } catch (err: any) {
                if (!isDeterministicMpaDebtBalanceError(err, plan)) {
                    throw err;
                }
                this.warn(`credit runtime: MPA combined operation failed; attempting collateral fallback: ${getErrorMessage(err)}`);
                await this.refreshMpaState(lendingItem);

                if (lendingItem.debtOnly) {
                    throw err;
                }

                // Combined op failed for debt balance, so a debt-only retry would fail too.
                // Try collateral-only repair; if unavailable, surface the original broadcast failure.
                const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
                const configuredCollateralAssetId = configuredCollateralAsset?.id;
                const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;
                const posState = this.state.positions[posKey];
                const collateralPlan = buildCollateralFallbackPlan({
                    currentCollateralAmount: posState?.currentCollateralAmount,
                    currentDebtAmount: posState?.currentDebtAmount,
                    feedPrice: posState?.feedPrice,
                    targetCollateralRatio: plan.targetCollateralRatio,
                    maxCollateralAmount: posState?.assignedCollateralBudget ?? lendingItem.maxCollateralAmount,
                    collateralLimitReferenceAmount: posState?.currentCollateralFundsTotal,
                });
                if (collateralPlan) {
                    const collateralOp = await this.buildMpaUpdateOperation(collateralPlan, { leg: 'collateral' }, lendingItem, assetId);
                    if (collateralOp) {
                        result = await this.executeOperations([collateralOp], `mpa maintenance:${context} collateral fallback`);
                        executed.push({ leg: 'collateral-fallback', operation: collateralOp, result });
                        await this.refreshMpaState(lendingItem);
                    }
                }
                if (executed.length === 0) {
                    throw err;
                }
            }
        }

        if (executed.length > 0) {
            const lastAction = {
                context,
                plan,
                executedAt: new Date().toISOString(),
                executed,
            };
            const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
            const configuredCollateralAssetId = configuredCollateralAsset?.id;
            const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].lastMpaAction = lastAction;

            this.state.lastCrAdjustment = {
                context,
                plan,
                executedAt: new Date().toISOString(),
            };
            if (typeof this.bot?.requestGridReset === 'function') {
                try {
                    const resetReason = plan.resetReason || 'cr-adjustment';
                    const resetResult = await this.bot.requestGridReset(resetReason);
                    this.state.lastGridResetAt = new Date().toISOString();
                    return { plan, executed, resetResult };
                } catch (err: any) {
                    this.warn(`credit runtime: grid reset after CR adjustment failed: ${getErrorMessage(err)}`);
                    return { plan, executed, resetError: getErrorMessage(err) };
                }
            }
            return { plan, executed };
        }
        return null;
    }

    async _runCreditMaintenance(lendingItem: any, assetId: any, runtimeContext: Record<string, any> = {}): Promise<any> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_runCreditMaintenance requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_runCreditMaintenance requires an assetId');
        }

        const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const configuredCollateralAssetId = configuredCollateralAsset?.id;
        const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;

        // Phase 1: Proactively repay deals nearing expiration before processing reborrows
        const expiryThresholdHours = this.bot?.config?.TIMING?.CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS ?? 12;
        const expiryThresholdMs = expiryThresholdHours * 60 * 60 * 1000;

        const posState = this.state.positions[posKey];
        if (!posState) return null;

        // Phase 0: Split oversized credit deals that exceed maxBorrowAmountPerOperation
        try {
            const splitResult = await this._splitOversizedCreditDeals(lendingItem, assetId, posState, runtimeContext);
            if (splitResult) {
                this.log(`credit runtime: restructured oversized deals for ${assetId}`);
            }
        } catch (err: any) {
            this.warn(`credit runtime: deal restructuring failed: ${getErrorMessage(err)}`);
        }

        let activeDealIds = new Set((posState.creditDeals || []).map((d: any) => String(d?.id)).filter(Boolean));

        for (const deal of (posState.creditDeals || [])) {
            if (!activeDealIds.has(String(deal?.id))) continue;
            if (!deal.latestRepayTime) continue;
            const timeLeft = new Date(deal.latestRepayTime as string | number).getTime() - Date.now();
            if (timeLeft < expiryThresholdMs) {
                try {
                    this.warn(`credit runtime: deal ${deal.id} expires in ${Math.round(timeLeft / 60000)}m; proactively repaying and reborrowing`);
                    const debtAsset = await this._resolveAsset(deal.debtAssetId);
                    const repayAmount = blockchainAmountToFloat(deal.debtAmount, debtAsset);
                    if (repayAmount == null || repayAmount <= 0) {
                        throw new Error(`unable to convert deal ${deal.id} debt amount for repay`);
                    }
                    const isCollateralMismatch = deal.collateralMismatch === true;
                    let existingCollateralAmount: number | null = null;
                    if (isCollateralMismatch) {
                        const accountRef = getAccountRef(this.bot);
                        const balances = await chainOrders.getOnChainAssetBalances(accountRef, [configuredCollateralAssetId]);
                        const balance = (balances as Record<string, any>)?.[String(configuredCollateralAssetId)] || (balances as Record<string, any>)?.[String(configuredCollateralAsset?.symbol)] || null;
                        const available = toFiniteNumber(balance?.total, undefined);
                        if (!Number.isFinite(available) || available <= 0) {
                            this.warn(`credit runtime: skipping collateral switch for deal ${deal.id} — no balance of new collateral ${configuredCollateralAssetId}`);
                            continue;
                        }
                    }
                    if (!isCollateralMismatch) {
                        const collateralAsset = await this._resolveAsset(deal.collateralAssetId);
                        existingCollateralAmount = blockchainAmountToFloat(deal.collateralAmount, collateralAsset);
                        if (existingCollateralAmount == null || existingCollateralAmount <= 0) {
                            throw new Error(`unable to convert deal ${deal.id} collateral amount for release`);
                        }
                    }
                    // Snapshot pre-existing pending reborrows for this deal so we
                    // can prune stale ones after repayCreditDeal without removing
                    // any new deferred entry that repayCreditDeal itself may queue.
                    const staleSnapshot = Array.isArray(this.state.pendingReborrows)
                        ? this.state.pendingReborrows.filter(
                            (r: any) => r.sourceDealId === String(deal.id)
                        )
                        : [];
                    const staleKeys = new Set(
                        staleSnapshot.map((r: any) => `${r.sourceDealId}:${r.offerId}:${r.requestedAt}`)
                    );

                    await this.repayCreditDeal(deal, repayAmount, {
                        autoReborrow: true,
                        collateralAmount: isCollateralMismatch ? null : {
                            amount: existingCollateralAmount,
                            assetId: deal.collateralAssetId,
                        },
                        collateralAsset: configuredCollateralAssetId,
                        pendingReleaseCollateralAmount: isCollateralMismatch ? null : existingCollateralAmount,
                        specificPolicy: lendingItem,
                    });

                    // Prune only the stale entries that existed before the call
                    // (identified by requestedAt), not any freshly queued one.
                    if (staleKeys.size > 0 && Array.isArray(this.state.pendingReborrows)) {
                        const before = this.state.pendingReborrows.length;
                        this.state.pendingReborrows = this.state.pendingReborrows.filter(
                            (r: any) => !staleKeys.has(`${r.sourceDealId}:${r.offerId}:${r.requestedAt}`)
                        );
                        if (this.state.pendingReborrows.length < before) {
                            this.log(`credit runtime: pruned ${before - this.state.pendingReborrows.length} stale pending reborrow(s) for deal ${deal.id}`);
                        }
                        this.state.reborrowPending = this.state.pendingReborrows.length > 0;
                    }
                    // repayCreditDeal calls refreshState() which mutates this.state.positions[posKey];
                    // re-read from fresh state for subsequent loop iterations
                    const refreshedPosState = this.state.positions[posKey];
                    if (refreshedPosState && Array.isArray(refreshedPosState.creditDeals)) {
                        activeDealIds = new Set(refreshedPosState.creditDeals.map((d: any) => String(d?.id)).filter(Boolean));
                    } else {
                        activeDealIds.delete(String(deal.id));
                    }
                } catch (err: any) {
                    this.warn(`credit runtime: proactive repay/reborrow for deal ${deal.id} failed: ${getErrorMessage(err)}`);
                }
            }
        }

        // Phase 2: Ensure auto_repay matches policy on existing deals
        const policyAutoRepay = resolveAutoRepayValue(lendingItem?.autoRepay);
        if (policyAutoRepay > 0) {
            const currentDeals = (this.state.positions[posKey]?.creditDeals) || [];
            for (const deal of currentDeals) {
                if (resolveAutoRepayValue(deal.autoRepay) !== policyAutoRepay) {
                    try {
                        this.log(`credit runtime: updating auto_repay on deal ${deal.id} to ${policyAutoRepay}`);
                        const updateOp = await this.buildCreditDealUpdateOperation(deal, policyAutoRepay);
                        await this.executeOperations([updateOp], 'credit deal auto_repay update');
                        deal.autoRepay = policyAutoRepay;
                    } catch (err: any) {
                        this.warn(`credit runtime: failed to update auto_repay on deal ${deal.id}: ${getErrorMessage(err)}`);
                    }
                }
            }
        }

        // Phase 3: If collateral distribution assigns more credit capacity than current deals use,
        // accept an additional deal to move the asset back toward its target output ratio.
        if (lendingItem.renewOnly !== true) {
            const increasePlan = await this._buildCreditIncreasePlan(lendingItem, assetId, posState);
            if (increasePlan) {
                const offer = await this._selectCreditOfferForIncrease({
                    debtAssetId: assetId,
                    collateralAssetId: configuredCollateralAssetId,
                    policy: lendingItem,
                    collateralAmount: {
                        amount: increasePlan.collateralIncreaseAmount,
                        assetId: configuredCollateralAssetId,
                    },
                    minCollateralIncrease: increasePlan.minCollateralIncrease,
                    remainingBorrowCapacity: increasePlan.remainingBorrowCapacity,
                    autoRepay: lendingItem.autoRepay ?? false,
                });
                if (offer) {
                    const result = await this.executeOperations([offer.op], 'credit increase');
                    posState.lastCreditIncrease = {
                        plan: increasePlan,
                        cappedByBorrowCapacity: !!offer.capped,
                        collateralAmount: offer.collateralAmount,
                        borrowAmount: offer.borrowAmount,
                        offerId: offer.offer.id,
                        executedAt: new Date().toISOString(),
                    };
                    await this.refreshCreditState({}, lendingItem);
                    const gridMaintenanceResult = await this._checkGridMaintenanceAfterCreditUpdate('credit capital update', {
                    });
                    return {
                        plan: increasePlan,
                        offer: offer.offer.id,
                        cappedByBorrowCapacity: !!offer.capped,
                        collateralAmount: offer.collateralAmount,
                        borrowAmount: offer.borrowAmount,
                        gridMaintenanceResult,
                        result,
                    };
                }
                this.warn(`credit runtime: no acceptable credit offer found for ${assetId} collateral increase of ${increasePlan.collateralIncreaseAmount}`);
            }
        }

        return null;
    }

    async runMaintenance(context: any = 'periodic', options: Record<string, any> = {}): Promise<any> {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }
        if (this._maintenanceInFlight) {
            return { skipped: true, reason: 'maintenance already in flight' };
        }
        this._maintenanceInFlight = true;

        try {
            await this.refreshState();

            const results: Record<string, any> = {
                context,
                mpa: [] as any[],
                credit: [] as any[],
            };

            const dp = this.debtPolicy;
            for (const item of dp.lending) {
                const resolvedAsset = await this._resolveAsset(item.asset);
                const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                if (!assetId) {
                    this.warn(`credit runtime: unable to resolve asset "${item.asset}" for lending item; skipping`);
                    continue;
                }
                if (item.type === 'mpa') {
                    results.mpa.push(await this._runMpaMaintenance(context, options, item, assetId));
                } else if (item.type === 'creditOffer') {
                    results.credit.push(await this._runCreditMaintenance(item, assetId, { context, options }));
                }
            }

            const reborrowResult = await this.processPendingReborrows();
            await this.persistState(context);
            return { ...results, reborrows: reborrowResult };
        } finally {
            this._maintenanceInFlight = false;
        }
    }

    async runCreditWatchdog(): Promise<any> {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }
        if (this._watchdogInFlight) {
            return { skipped: true, reason: 'watchdog already in flight' };
        }
        this._watchdogInFlight = true;
        try {
            await this.refreshState();

            const mpaResults: any[] = [];
            const creditResults: any[] = [];

            const dp = this.debtPolicy;
            for (const item of dp.lending) {
                const resolvedAsset = await this._resolveAsset(item.asset);
                const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                if (!assetId) {
                    this.warn(`credit runtime: unable to resolve asset "${item.asset}" for lending item; skipping`);
                    continue;
                }
                if (item.type === 'mpa') {
                    mpaResults.push(await this._runMpaMaintenance('watchdog', {}, item, assetId));
                } else if (item.type === 'creditOffer') {
                    creditResults.push(await this._runCreditMaintenance(item, assetId, { context: 'watchdog', options: {} }));
                }
            }

            const reborrowResult = await this.processPendingReborrows();
            await this.persistState('watchdog');
            return {
                mpa: mpaResults,
                credit: creditResults,
                reborrows: reborrowResult,
                remainingDeals: Array.isArray(this.state.creditDeals) ? this.state.creditDeals.length : 0,
            };
        } catch (err: any) {
            this.warn(`credit runtime: watchdog error: ${getErrorMessage(err)}`);
            return { skipped: true, reason: getErrorMessage(err) };
        } finally {
            this._watchdogInFlight = false;
        }
    }

    /**
     * Get total collateral (MPA + credit deals) per asset from the debt snapshot.
     * @param {Array<string>} assetIds - Asset IDs to look up
     * @returns {Object} mapping assetId -> total collateral float
     */
    getCollateralOffsets(assetIds: any) {
        const snapshot: Record<string, any> = this.state?.debtSnapshot?.assets || {};
        const result: Record<string, any> = {};
        for (const assetId of assetIds) {
            const key = String(assetId);
            const entry = snapshot[key];
            result[key] = toFiniteNumber(entry?.totalCollateral, 0);
        }
        return result;
    }

    getStateSnapshot(): any {
        return deepClone(this.state);
    }
}

export default CreditRuntime

module.exports = CreditRuntime
