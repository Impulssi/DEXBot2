'use strict';

const { NATIVE_CLIENT } = require('../constants');
const { RESOLVERS } = NATIVE_CLIENT;

interface CacheEntry {
    value: any;
    ts: number;
}

class LRUCache {
    maxSize: number;
    ttlMs: number | null;
    cache: Map<string, CacheEntry>;

    constructor(maxSize: number = RESOLVERS.LRU_DEFAULT_SIZE, ttlMs: number | null = null) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.cache = new Map();
    }

    get(key: string): any | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (this.ttlMs && Date.now() - entry.ts > this.ttlMs) {
            this.cache.delete(key);
            return undefined;
        }

        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    /**
     * Return the cached value even if expired (stale read).
     * Does not delete or LRU-promote the entry — just peeks.
     * Use as a fallback when a fresh fetch fails.
     */
    getStale(key: string): { value: any; expired: boolean } | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        const expired = this.ttlMs ? Date.now() - entry.ts > this.ttlMs : false;
        return { value: entry.value, expired };
    }

    set(key: string, value: any): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, ts: Date.now() });
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number { return this.cache.size; }
}

export = { LRUCache };
