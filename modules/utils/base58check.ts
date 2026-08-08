

import { createHash, timingSafeEqual } from '../crypto/sync.js';
import { getCrypto } from '../crypto/index.js';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((ch, index) => [ch, index]));

// ── Sync (Node crypto) — used by chain_keys, ecc.ts ────────────────
function checksum(payload: Uint8Array | string): Uint8Array {
    const first = createHash('sha256').update(payload).digest() as Uint8Array;
    return (createHash('sha256').update(first).digest() as Uint8Array).subarray(0, 4);
}

function base58Encode(buffer: Uint8Array | number[] | string): string {
    const bytes = typeof buffer === 'string' ? new TextEncoder().encode(buffer)
                 : buffer instanceof Uint8Array ? buffer
                 : new Uint8Array(buffer);
    if (bytes.length === 0) return '';

    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) + BigInt(byte);
    }

    let encoded = '';
    while (value > 0n) {
        const mod = Number(value % 58n);
        encoded = ALPHABET[mod] + encoded;
        value /= 58n;
    }

    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = '1' + encoded;
    }

    return encoded || '1';
}

function base58Decode(value: string): Uint8Array {
    if (typeof value !== 'string') throw new TypeError('Base58 value must be a string');
    if (value.length === 0) return new Uint8Array(0);

    let decoded = 0n;
    for (const ch of value) {
        const digit = ALPHABET_MAP.get(ch);
        if (digit === undefined) throw new Error(`Invalid base58 character "${ch}"`);
        decoded = decoded * 58n + BigInt(digit);
    }

    const bytes: number[] = [];
    while (decoded > 0n) {
        bytes.unshift(Number(decoded & 0xffn));
        decoded >>= 8n;
    }

    for (const ch of value) {
        if (ch !== '1') break;
        bytes.unshift(0);
    }

    return new Uint8Array(bytes);
}

function encode(payload: Uint8Array | string): string {
    const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const csum = checksum(body);
    const combined = new Uint8Array(body.length + csum.length);
    combined.set(body);
    combined.set(csum, body.length);
    return base58Encode(combined);
}

function decode(value: string): Uint8Array {
    const decoded = base58Decode(value);
    if (decoded.length < 4) throw new Error('Invalid Base58Check payload');

    const payload = decoded.subarray(0, -4);
    const expected = decoded.subarray(-4);
    const actual = checksum(payload);
    if (!timingSafeEqual(expected, actual)) {
        throw new Error('Invalid Base58Check checksum');
    }

    return payload;
}

// ── Async (CryptoProvider) — browser-safe, returns Uint8Array ──────
async function checksumAsync(payload: Uint8Array): Promise<Uint8Array> {
    const provider = getCrypto();
    const first = await provider.sha256(payload);
    const second = await provider.sha256(first);
    return second.slice(0, 4);
}

async function encodeAsync(payload: Uint8Array): Promise<string> {
    const csum = await checksumAsync(payload);
    const combined = new Uint8Array(payload.length + csum.length);
    combined.set(payload);
    combined.set(csum, payload.length);
    return base58Encode(combined);
}

async function decodeAsync(value: string): Promise<Uint8Array> {
    const provider = getCrypto();
    const decoded = base58Decode(value);
    if (decoded.length < 4) throw new Error('Invalid Base58Check payload');

    const payload = decoded.subarray(0, -4);
    const expected = decoded.subarray(-4);
    const actual = await checksumAsync(payload);
    if (!await provider.timingSafeEqual(expected, actual)) {
        throw new Error('Invalid Base58Check checksum');
    }

    return payload;
}

export { base58Encode, base58Decode, decode, encode, encodeAsync, decodeAsync }

