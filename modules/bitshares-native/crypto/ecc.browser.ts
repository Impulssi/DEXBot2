// @ts-nocheck — TypeScript Uint8Array generic parameter quirks are
// not relevant for this browser-targeted file.
/**
 * Browser-portable ECC — pure-JS secp256k1 operations.
 * Drop-in replacement for ecc.ts in browser contexts.
 *
 * Uses:
 *   - CryptoProvider for hashing, HMAC, randomBytes
 *   - pure_secp256k1 for EC point math
 *   - pure_ripemd160 for RIPEMD-160
 *   - Uint8Array everywhere (no Buffer)
 *
 * Exports the same API shape as ecc.ts (async where hashing/crypto is needed).
 */

import { getCrypto } from '../../crypto/index.js';
import * as pureSecp from '../../crypto/pure_secp256k1.js';
'use strict';

import type { EcPoint } from '../../crypto/provider.js';

import { base58Encode as _base58Encode, base58Decode as _base58Decode } from '../../utils/base58check.js';
const secp256k1 = pureSecp.secp256k1;
const pointFromPublicKey = pureSecp.pointFromPublicKey;
const publicKeyFromPoint = pureSecp.publicKeyFromPoint;
const ecPointMul = pureSecp.ecPointMul;
const ecPointAdd = pureSecp.ecPointAdd;
const ecPointDouble = pureSecp.ecPointDouble;
const modPow = pureSecp.modPow;
const modInverse = pureSecp.modInverse;
const mod = pureSecp.mod;

// ── Helpers ─────────────────────────────────────────────────────────

function bufToHex(buf: Uint8Array): string {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
    const len = hex.length >> 1;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

function concatBuf(...arrays: Uint8Array[]): Uint8Array {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

function sliceBuf(buf: Uint8Array, start: number, end?: number): Uint8Array {
    return buf.slice(start, end ?? buf.length);
}

function equalsBuf(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ── Curve constants ─────────────────────────────────────────────────
const SECP256K1_BASE_POINT: EcPoint = { x: secp256k1.Gx, y: secp256k1.Gy };
// ── Hashing (async, via CryptoProvider) ─────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().sha256(data);
}

async function sha512(data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().sha512(data);
}

async function ripemd160(data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().ripemd160(data);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    return getCrypto().hmacSha256(key, data);
}

async function hash160(data: Uint8Array): Promise<Uint8Array> {
    return ripemd160(await sha256(data));
}

async function hash256(data: Uint8Array): Promise<Uint8Array> {
    return sha256(await sha256(data));
}

async function randomBytes(length: number): Promise<Uint8Array> {
    return getCrypto().randomBytes(length);
}

// ── Key generation / validation ─────────────────────────────────────

function bigIntFromBuffer(buf: Uint8Array): bigint {
    return pureSecp.bigIntFromBuffer(buf);
}

function bufferFromBigInt(bn: bigint, length = 32): Uint8Array {
    return pureSecp.bufferFromBigInt(bn, length);
}

function isValidPrivateKey(rawKey: Uint8Array): boolean {
    if (rawKey.length !== 32) return false;
    const keyInt = bigIntFromBuffer(rawKey);
    return keyInt > 0n && keyInt < secp256k1.n;
}

async function generatePrivateKey(): Promise<Uint8Array> {
    let key: Uint8Array;
    do {
        key = await randomBytes(32);
    } while (!isValidPrivateKey(key));
    return key;
}

async function privateKeyToPublicKey(rawKey: Uint8Array, compressed = true): Promise<Uint8Array> {
    if (rawKey.length !== 32) throw new Error('Invalid private key: must be 32 bytes');
    return pureSecp.privateKeyToPublicKey(rawKey, compressed);
}

// ── DER parsing ─────────────────────────────────────────────────────

function sigFromDer(derSig: Uint8Array): { r: Uint8Array; s: Uint8Array } {
    if (derSig.length < 8 || derSig[0] !== 0x30) throw new Error('Invalid DER signature: missing sequence tag');
    let offset = 2;
    if (derSig[1] & 0x80) {
        const lenBytes = derSig[1] & 0x7F;
        if (lenBytes > 2) throw new Error('Invalid DER signature: length too large');
        let seqLen = 0;
        for (let i = 0; i < lenBytes; i++) seqLen = (seqLen << 8) | derSig[2 + i];
        offset = 2 + lenBytes;
    }
    if (offset >= derSig.length || derSig[offset] !== 0x02) throw new Error('Invalid DER signature: missing r integer tag');
    const rLen = derSig[offset + 1];
    const rStart = offset + 2;
    if (rStart + rLen > derSig.length) throw new Error('Invalid DER signature: r value truncated');
    const r = derSig.slice(rStart, rStart + rLen);
    const sTagOffset = rStart + rLen;
    if (sTagOffset >= derSig.length || derSig[sTagOffset] !== 0x02) throw new Error('Invalid DER signature: missing s integer tag');
    const sLen = derSig[sTagOffset + 1];
    const sStart = sTagOffset + 2;
    if (sStart + sLen > derSig.length) throw new Error('Invalid DER signature: s value truncated');
    const s = derSig.slice(sStart, sStart + sLen);
    return { r, s };
}

// ── Deterministic K (RFC 6979) ─────────────────────────────────────

async function deterministicK(digest: Uint8Array, privateKey: Uint8Array, counter = 0): Promise<bigint> {
    const x = bufferFromBigInt(bigIntFromBuffer(privateKey), 32);
    const h1 = bufferFromBigInt(bigIntFromBuffer(digest) % secp256k1.n, 32);
    const zero = new Uint8Array(1);
    const one = new Uint8Array([0x01]);
    const empty = new Uint8Array(0);

    let K = new Uint8Array(32);
    let V = new Uint8Array(32).fill(0x01);

    K = new Uint8Array(await hmacSha256(K, concatBuf(V, zero, x, h1)));
    V = new Uint8Array(await hmacSha256(K, V));
    K = new Uint8Array(await hmacSha256(K, concatBuf(V, one, x, h1)));
    V = new Uint8Array(await hmacSha256(K, V));

    let retry = false;
    const rfc6979Generate = async (): Promise<Uint8Array> => {
        if (retry) {
            K = new Uint8Array(await hmacSha256(K, concatBuf(V, zero)));
            V = new Uint8Array(await hmacSha256(K, V));
        }
        V = new Uint8Array(await hmacSha256(K, V));
        const output = new Uint8Array(V);
        retry = true;
        return output;
    };

    const total = counter + 2;
    let lastOutput: Uint8Array;
    for (let i = 0; i < total; i++) {
        lastOutput = await rfc6979Generate();
    }

    const candidate = bigIntFromBuffer(lastOutput!);
    if (candidate > 0n && candidate < secp256k1.n) return candidate;
    return 0n;
}

// ── Recovery ────────────────────────────────────────────────────────

function recoverPublicKey(digest: Uint8Array, r: Uint8Array, s: Uint8Array, recoveryId: number): Uint8Array {
    const n = secp256k1.n;
    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    const e = bigIntFromBuffer(digest) % n;

    if (rBig < 1n || rBig >= n || sBig < 1n || sBig >= n) throw new Error('Invalid signature parameters');

    const isYOdd = recoveryId & 1;
    const recoveryGroup = recoveryId >> 1;
    const x = rBig + BigInt(recoveryGroup) * n;
    if (x >= secp256k1.p) throw new Error('Invalid recovery point');

    const alpha = (x * x * x + secp256k1.a * x + secp256k1.b) % secp256k1.p;
    let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);
    if ((y & 1n) !== BigInt(isYOdd)) y = secp256k1.p - y;

    const R: EcPoint = { x, y };
    const rInv = modInverse(rBig, n);
    const eNeg = (n - (e % n)) % n;
    const sr = ecPointMul(R, sBig);
    const eGNeg = ecPointMul(SECP256K1_BASE_POINT, eNeg);
    if (!sr || !eGNeg) throw new Error('Failed to compute recovery terms');
    const sum = ecPointAdd(sr, eGNeg);
    if (!sum) throw new Error('Failed to recover public key point');
    const Q = ecPointMul(sum, rInv);
    if (!Q) throw new Error('Failed to recover public key');
    return publicKeyFromPoint(Q);
}

// ── Sign / Verify ───────────────────────────────────────────────────

async function sign(digest: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
    if (privateKey.length !== 32) throw new Error('Private key must be 32 bytes');

    const d = bigIntFromBuffer(privateKey);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const nHalf = secp256k1.n >> 1n;
    const pubKeyKnown = await privateKeyToPublicKey(privateKey, true);

    const MAX_SIGN_RETRIES = 256;
    let nonce = 0;
    while (nonce < MAX_SIGN_RETRIES) {
        const k = await deterministicK(digest, privateKey, nonce);
        if (k === 0n) { nonce++; continue; }
        const R = ecPointMul(SECP256K1_BASE_POINT, k);
        const rBig = R ? R.x % secp256k1.n : 0n;
        if (!R || rBig === 0n) { nonce++; continue; }

        let sBig = mod(modInverse(k, secp256k1.n) * (e + rBig * d), secp256k1.n);
        if (sBig === 0n) { nonce++; continue; }

        let recoveryId = (R.y & 1n) === 1n ? 1 : 0;
        if (R.x >= secp256k1.n) recoveryId |= 2;
        if (sBig > nHalf) { sBig = secp256k1.n - sBig; recoveryId ^= 1; }

        const rBuf = bufferFromBigInt(rBig, 32);
        const sBuf = bufferFromBigInt(sBig, 32);

        if (!(rBuf[0] < 0x80 && (rBuf[0] !== 0 || rBuf[1] >= 0x80))) { nonce++; continue; }
        if (!(sBuf[0] < 0x80 && (sBuf[0] !== 0 || sBuf[1] >= 0x80))) { nonce++; continue; }

        for (let i = 0; i < 4; i++) {
            try {
                const recovered = recoverPublicKey(digest, rBuf, sBuf, i);
                if (equalsBuf(recovered, pubKeyKnown)) { recoveryId = i; break; }
            } catch (_) {}
        }
        if (recoveryId < 0 || recoveryId > 3) { nonce++; continue; }

        const compactI = recoveryId + 27 + 4;
        return concatBuf(new Uint8Array([compactI]), rBuf, sBuf);
    }
    throw new Error(`Failed to produce valid signature after ${MAX_SIGN_RETRIES} retries`);
}

async function verify(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array | string): Promise<boolean> {
    if (digest.length !== 32) throw new Error('Digest must be 32 bytes');

    let r: Uint8Array;
    let s: Uint8Array;
    if (signature.length === 65) { r = signature.slice(1, 33); s = signature.slice(33, 65); }
    else if (signature.length === 64) { r = signature.slice(0, 32); s = signature.slice(32, 64); }
    else throw new Error('Invalid signature length: ' + signature.length);

    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    if (rBig <= 0n || rBig >= secp256k1.n || sBig <= 0n || sBig >= secp256k1.n) return false;

    const pubBuf = typeof publicKey === 'string' ? hexToBuf(publicKey) : publicKey;
    const Q = pointFromPublicKey(pubBuf);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const w = modInverse(sBig, secp256k1.n);
    const u1 = mod(e * w, secp256k1.n);
    const u2 = mod(rBig * w, secp256k1.n);
    const point = ecPointAdd(ecPointMul(SECP256K1_BASE_POINT, u1), ecPointMul(Q, u2));
    if (!point) return false;
    return mod(point.x, secp256k1.n) === rBig;
}

// ── Base58 (wrappers around shared utils) ───────────────────────────

function base58Encode(buf: Uint8Array): string {
    return _base58Encode(buf);
}

function base58Decode(str: string): Uint8Array {
    return _base58Decode(str);
}

async function base58CheckEncode(payload: Uint8Array): Promise<string> {
    const csum = (await hash256(payload)).slice(0, 4);
    return base58Encode(concatBuf(payload, csum));
}

async function base58CheckDecode(str: string): Promise<Uint8Array> {
    const decoded = base58Decode(str);
    if (decoded.length < 4) throw new Error('Invalid base58check: too short');
    const payload = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);
    const expected = (await hash256(payload)).slice(0, 4);
    if (!equalsBuf(checksum, expected)) throw new Error('Invalid base58check: checksum mismatch');
    return payload;
}

// ── WIF ─────────────────────────────────────────────────────────────

interface WifDecodeResult {
    privateKey: Uint8Array;
    compressed: boolean;
}

async function wifEncode(privateKey: Uint8Array, compressed = true): Promise<string> {
    if (privateKey.length !== 32) throw new Error('Private key must be 32 bytes');
    let payload = concatBuf(new Uint8Array([0x80]), privateKey);
    if (compressed) payload = concatBuf(payload, new Uint8Array([0x01]));
    return base58CheckEncode(payload);
}

async function wifDecode(wif: string): Promise<WifDecodeResult> {
    const payload = await base58CheckDecode(wif);
    if (payload.length < 33) throw new Error('Invalid WIF: too short');
    if (payload[0] !== 0x80) throw new Error('Invalid WIF: wrong version byte');
    const compressed = payload.length === 34 && payload[33] === 0x01;
    const privateKey = payload.slice(1, 33);
    if (!isValidPrivateKey(privateKey)) throw new Error('Invalid WIF: invalid private key');
    return { privateKey, compressed };
}

// ── DER encoding ────────────────────────────────────────────────────

function buildPublicKeyDer(compressedPub: Uint8Array): Uint8Array {
    let point: Uint8Array;
    if (compressedPub.length === 64) {
        point = concatBuf(new Uint8Array([0x04]), compressedPub);
    } else if (compressedPub.length === 33) {
        const prefix = compressedPub[0];
        const x = bigIntFromBuffer(compressedPub.slice(1, 33));
        const x3 = x * x * x;
        const ySq = (x3 + secp256k1.b) % secp256k1.p;
        let y = modPow(ySq, (secp256k1.p + 1n) / 4n, secp256k1.p);
        if ((y & 1n) !== BigInt(prefix === 0x03)) y = secp256k1.p - y;
        point = concatBuf(new Uint8Array([0x04]), bufferFromBigInt(x, 32), bufferFromBigInt(y, 32));
    } else if (compressedPub.length === 65) {
        point = compressedPub;
    } else {
        throw new Error('Unsupported public key length: ' + compressedPub.length);
    }
    const seqHeader = hexToBuf('3056301006072a8648ce3d020106052b8104000a034200');
    return concatBuf(seqHeader, point);
}

function buildSignatureDer(r: Uint8Array, s: Uint8Array): Uint8Array {
    const encodeInt = (buf: Uint8Array): Uint8Array => {
        let data = buf;
        if (data[0] & 0x80) data = concatBuf(new Uint8Array([0x00]), data);
        return concatBuf(new Uint8Array([0x02, data.length]), data);
    };
    const rEnc = encodeInt(r);
    const sEnc = encodeInt(s);
    return concatBuf(new Uint8Array([0x30, rEnc.length + sEnc.length]), rEnc, sEnc);
}

// ── Brain key ───────────────────────────────────────────────────────

async function normalizeBrainKey(name: string, role: string, password: string): Promise<Uint8Array> {
    const combined = `${name} ${role} ${password}`.replace(/\s+/g, ' ').trim();
    return sha256(await sha512(new TextEncoder().encode(combined)));
}

async function brainKeyToPrivateKey(brainKey: Uint8Array | string, sequence = 0): Promise<Uint8Array> {
    const seq = ` ${sequence}`;
    const combined = typeof brainKey === 'string'
        ? brainKey + seq
        : new TextDecoder().decode(brainKey) + seq;
    return sha256(await sha512(new TextEncoder().encode(combined)));
}

// ── Address formatting ──────────────────────────────────────────────

async function publicKeyToString(pubKeyBuf: Uint8Array, addressPrefix = 'BTS'): Promise<string> {
    const csum = (await sha256(pubKeyBuf)).slice(0, 4);
    return addressPrefix + base58Encode(concatBuf(pubKeyBuf, csum));
}

async function addressFromPublicKey(pubKeyBuf: Uint8Array, addressPrefix = 'BTS'): Promise<string> {
    const hash = await ripemd160(await sha512(pubKeyBuf));
    const csum = (await ripemd160(hash)).slice(0, 4);
    return addressPrefix + base58Encode(concatBuf(hash, csum));
}

function publicKeyFromBuffer(pubKeyBuffer: Uint8Array): Uint8Array {
    return pubKeyBuffer;
}

// ── Exports ─────────────────────────────────────────────────────────

export { sha256, sha512, ripemd160, hash160, hash256, randomBytes, generatePrivateKey, isValidPrivateKey, privateKeyToPublicKey, sign, verify, recoverPublicKey, wifEncode, wifDecode, normalizeBrainKey, brainKeyToPrivateKey, publicKeyToString, addressFromPublicKey, publicKeyFromBuffer, base58Encode, base58Decode, base58CheckEncode, base58CheckDecode, buildSignatureDer, buildPublicKeyDer, secp256k1 }

