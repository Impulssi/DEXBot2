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

let _crypto: any;
try {
    _crypto = isBrowser() ? null : _require ? _require('crypto') : null;
} catch {
    _crypto = null;
}

function throwNoCrypto(name: string): never {
    throw new Error(`crypto.${name} is not available in browser; use getCrypto() async API`);
}

export const createHash = _crypto ? _crypto.createHash.bind(_crypto) : ((..._: any[]) => throwNoCrypto('createHash')) as any;
export const createHmac = _crypto ? _crypto.createHmac.bind(_crypto) : ((..._: any[]) => throwNoCrypto('createHmac')) as any;
export const randomBytes = _crypto ? _crypto.randomBytes.bind(_crypto) : ((..._: any[]) => throwNoCrypto('randomBytes')) as any;
export const timingSafeEqual = _crypto ? _crypto.timingSafeEqual.bind(_crypto) : ((..._: any[]) => throwNoCrypto('timingSafeEqual')) as any;
export const hkdfSync = _crypto ? _crypto.hkdfSync.bind(_crypto) : ((..._: any[]) => throwNoCrypto('hkdfSync')) as any;
export const scryptSync = _crypto ? _crypto.scryptSync.bind(_crypto) : ((..._: any[]) => throwNoCrypto('scryptSync')) as any;
export const createCipheriv = _crypto ? _crypto.createCipheriv.bind(_crypto) : ((..._: any[]) => throwNoCrypto('createCipheriv')) as any;
export const createDecipheriv = _crypto ? _crypto.createDecipheriv.bind(_crypto) : ((..._: any[]) => throwNoCrypto('createDecipheriv')) as any;
export const createECDH = _crypto ? _crypto.createECDH.bind(_crypto) : ((..._: any[]) => throwNoCrypto('createECDH')) as any;
