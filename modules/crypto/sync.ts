'use strict';



/**
 * Node-only sync crypto operations.
 *
 * WARNING: These are Node.js only. Browser code must use getCrypto() async API.
 * This module exists solely to centralize `require('crypto')` into one place so
 * that the 12+ files that previously imported it directly now import from here.
 *
 * In browser environments, all exports are stub functions that throw a clear error.
 */

import { isBrowser } from '../env.js';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

type NodeCrypto = typeof import('node:crypto');

let _crypto: NodeCrypto | null;
try {
    _crypto = isBrowser() ? null : _require ? _require('crypto') as NodeCrypto : null;
} catch {
    _crypto = null;
}

function throwNoCrypto(name: string): never {
    throw new Error(`crypto.${name} is not available in browser; use getCrypto() async API`);
}

function bind<K extends keyof NodeCrypto>(name: K): NodeCrypto[K] {
    if (_crypto) {
        const fn = _crypto[name];
        return (typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown).bind(_crypto) : fn) as NodeCrypto[K];
    }
    return (() => throwNoCrypto(String(name))) as unknown as NodeCrypto[K];
}

export const createHash = bind('createHash');
export const createHmac = bind('createHmac');
export const randomBytes = bind('randomBytes');
export const timingSafeEqual = bind('timingSafeEqual');
export const hkdfSync = bind('hkdfSync');
export const scryptSync = bind('scryptSync');
export const createCipheriv = bind('createCipheriv');
export const createDecipheriv = bind('createDecipheriv');
export const createECDH = bind('createECDH');
