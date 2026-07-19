'use strict';

const { NATIVE_CLIENT } = require('../constants');
const { RESOLVERS } = NATIVE_CLIENT;
const { LRUCache } = require('./lru_cache');

const ASSET_TTL_MS: number = RESOLVERS.ASSET_TTL_MS;
const ACCOUNT_TTL_MS: number = RESOLVERS.ACCOUNT_TTL_MS;
const MAX_ASSETS: number = RESOLVERS.MAX_ASSETS;
const MAX_ACCOUNTS: number = RESOLVERS.MAX_ACCOUNTS;
const LRU_DEFAULT_SIZE: number = RESOLVERS.LRU_DEFAULT_SIZE;

interface ChainClientDb {
    get_assets(ids: string[]): Promise<any[]>;
    lookup_asset_symbols(symbols: string[]): Promise<any[]>;
    get_full_accounts(ids: string[], subscribe: boolean): Promise<any[][]>;
    [key: string]: (...args: any[]) => Promise<any>;
}

interface ChainClient {
    db: ChainClientDb;
}

function createResolvers(chainClient: ChainClient) {
    const assetCache = new LRUCache(MAX_ASSETS, ASSET_TTL_MS);
    const accountCache = new LRUCache(MAX_ACCOUNTS, ACCOUNT_TTL_MS);
    const accountIdCache = new LRUCache(MAX_ACCOUNTS, ACCOUNT_TTL_MS);

    async function resolveAsset(idOrSymbol: string): Promise<any> {
        if (!idOrSymbol) throw new Error('asset id or symbol required');

        const cacheKey = `asset:${idOrSymbol}`;
        const cached = assetCache.get(cacheKey);
        if (cached) return cached;

        let asset: any;
        try {
            if (/^1\.3\./.test(String(idOrSymbol))) {
                const assets = await chainClient.db.get_assets([idOrSymbol]);
                asset = assets && assets[0];
            } else {
                const assets = await chainClient.db.lookup_asset_symbols([idOrSymbol]);
                asset = assets && assets[0];
            }
        } catch (err: any) {
            throw new Error(`Failed to resolve asset ${idOrSymbol}: ${err.message}`);
        }

        if (!asset) throw new Error(`Asset not found: ${idOrSymbol}`);

        assetCache.set(cacheKey, asset);
        if (asset.symbol) assetCache.set(`asset:${asset.symbol}`, asset);
        if (asset.id) assetCache.set(`asset:${asset.id}`, asset);

        return asset;
    }

    async function resolveAccount(nameOrId: string): Promise<any> {
        if (!nameOrId) throw new Error('account name or id required');

        const cacheKey = `account:${nameOrId}`;
        const cached = accountCache.get(cacheKey);
        if (cached) return cached;

        try {
            const accounts = await chainClient.db.get_full_accounts([nameOrId], false);
            if (!accounts || !accounts[0]) throw new Error(`Account not found: ${nameOrId}`);

            const result = accounts[0][1] && accounts[0][1].account
                ? accounts[0][1].account
                : null;

            if (!result) throw new Error(`Account not found: ${nameOrId}`);

            accountCache.set(cacheKey, result);
            if (result.name) accountCache.set(`account:${result.name}`, result);
            if (result.id) accountCache.set(`account:${result.id}`, result);

            return result;
        } catch (err: any) {
            throw err;
        }
    }

    async function resolveAccountId(name: string): Promise<string> {
        if (!name) throw new Error('account name required');
        if (/^1\.2\./.test(String(name))) return name;

        const cacheKey = `id:${name}`;
        const cached = accountIdCache.get(cacheKey);
        if (cached) return cached;

        const account = await resolveAccount(name);
        if (account && account.id) {
            accountIdCache.set(cacheKey, account.id);
            return account.id;
        }
        throw new Error(`Could not resolve account ID for: ${name}`);
    }

    async function resolveAccountName(id: string): Promise<string> {
        if (!id) throw new Error('account id required');
        if (!/^1\.2\./.test(String(id))) return id;

        const cacheKey = `name:${id}`;
        const cached = accountIdCache.get(cacheKey);
        if (cached) return cached;

        const account = await resolveAccount(id);
        if (account && account.name) {
            accountIdCache.set(cacheKey, account.name);
            return account.name;
        }
        throw new Error(`Could not resolve account name for: ${id}`);
    }

    function invalidateAsset(assetId: string): void {
        assetCache.delete(`asset:${assetId}`);
    }

    function invalidateAccount(accountId: string): void {
        accountCache.delete(`account:${accountId}`);
        accountIdCache.delete(`name:${accountId}`);
    }

    return {
        resolveAsset,
        resolveAccount,
        resolveAccountId,
        resolveAccountName,
        invalidateAsset,
        invalidateAccount,
        getAssetCacheSize: () => assetCache.size,
        getAccountCacheSize: () => accountCache.size,
    };
}

export = { createResolvers };
