'use strict';

import { createHash, createHmac, randomBytes as cryptoRandomBytes, createECDH } from '../../crypto/sync.js';
import { base58Encode as _base58Encode, base58Decode as _base58Decode } from '../../utils/base58check.js';
import { getErrorMessage } from '../../utils/errors.js';

interface EcPoint {
    x: bigint;
    y: bigint;
}

interface WifDecodeResult {
    privateKey: Buffer;
    compressed: boolean;
}

const secp256k1 = {
    p: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'),
    n: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
    Gx: BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'),
    Gy: BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8'),
    a: BigInt(0),
    b: BigInt(7),
};

const SECP256K1_BASE_POINT: EcPoint = {
    x: secp256k1.Gx,
    y: secp256k1.Gy,
};

function sha256(data: Buffer): Buffer {
    return createHash('sha256').update(data).digest();
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
    return createHmac('sha256', key).update(data).digest();
}

function sha512(data: Buffer | string): Buffer {
    return createHash('sha512').update(data).digest();
}

function ripemd160(data: Buffer): Buffer {
    return createHash('ripemd160').update(data).digest();
}

function hash160(data: Buffer): Buffer {
    return ripemd160(sha256(data));
}

function hash256(data: Buffer): Buffer {
    return sha256(sha256(data));
}

function randomBytes(length: number): Buffer {
    return cryptoRandomBytes(length);
}

function generatePrivateKey(): Buffer {
    let key: Buffer;
    do {
        key = randomBytes(32);
    } while (!isValidPrivateKey(key));
    return key;
}

function isValidPrivateKey(rawKey: Buffer): boolean {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) return false;
    const keyInt = BigInt('0x' + rawKey.toString('hex'));
    return keyInt > 0n && keyInt < secp256k1.n;
}

function privateKeyToPublicKey(rawKey: Buffer, compressed = true): Buffer {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) {
        throw new Error('Invalid private key: must be 32 bytes');
    }
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(rawKey);
    return ecdh.getPublicKey(null, compressed ? 'compressed' : 'uncompressed');
}

function bigIntFromBuffer(buf: Buffer): bigint {
    return BigInt('0x' + buf.toString('hex'));
}

function bufferFromBigInt(bn: bigint, length = 32): Buffer {
    let hex = bn.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    if (hex.length > length * 2) {
        throw new Error(`BigInt 0x${bn.toString(16)} exceeds requested byte length ${length}`);
    }
    if (hex.length < length * 2) hex = hex.padStart(length * 2, '0');
    return Buffer.from(hex, 'hex');
}

function mod(value: bigint, modulus: bigint): bigint {
    return ((value % modulus) + modulus) % modulus;
}

function publicKeyFromBuffer(pubKeyBuffer: Buffer): Buffer {
    if (!Buffer.isBuffer(pubKeyBuffer)) {
        throw new Error('public key must be a Buffer');
    }
    return pubKeyBuffer;
}

function publicKeyFromPoint(point: EcPoint): Buffer {
    const prefix = (point.y & 1n) === 1n ? 0x03 : 0x02;
    const xBuf = bufferFromBigInt(point.x, 32);
    return Buffer.concat([Buffer.from([prefix]), xBuf]);
}

function pointFromPublicKey(pubKeyBuffer: Buffer): EcPoint {
    if (!Buffer.isBuffer(pubKeyBuffer)) {
        throw new Error('public key must be a Buffer');
    }
    if (pubKeyBuffer.length === 33) {
        const prefix = pubKeyBuffer[0];
        if (prefix !== 0x02 && prefix !== 0x03) {
            throw new Error('Unsupported compressed public key prefix');
        }
        const x = bigIntFromBuffer(pubKeyBuffer.slice(1));
        const alpha = mod(x * x * x + secp256k1.a * x + secp256k1.b, secp256k1.p);
        let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);
        if ((y & 1n) !== BigInt(prefix & 1)) {
            y = secp256k1.p - y;
        }
        return { x, y };
    }
    if (pubKeyBuffer.length === 65 && pubKeyBuffer[0] === 0x04) {
        return {
            x: bigIntFromBuffer(pubKeyBuffer.slice(1, 33)),
            y: bigIntFromBuffer(pubKeyBuffer.slice(33, 65)),
        };
    }
    if (pubKeyBuffer.length === 64) {
        return {
            x: bigIntFromBuffer(pubKeyBuffer.slice(0, 32)),
            y: bigIntFromBuffer(pubKeyBuffer.slice(32, 64)),
        };
    }
    throw new Error('Unsupported public key length: ' + pubKeyBuffer.length);
}

function deterministicK(digest: Buffer, privateKey: Buffer, counter = 0): bigint {
    const x = bufferFromBigInt(bigIntFromBuffer(privateKey), 32);
    const h1 = bufferFromBigInt(bigIntFromBuffer(digest) % secp256k1.n, 32);

    let K: Buffer<ArrayBufferLike> = Buffer.alloc(32, 0x00);
    let V: Buffer<ArrayBufferLike> = Buffer.alloc(32, 0x01);

    K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x00]), x, h1]));
    V = hmacSha256(K, V);
    K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x01]), x, h1]));
    V = hmacSha256(K, V);

    let retry = false;

    function rfc6979Generate(): Buffer<ArrayBufferLike> {
        if (retry) {
            K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x00])]));
            V = hmacSha256(K, V);
        }
        V = hmacSha256(K, V);
        const output = Buffer.from(V);
        retry = true;
        return output;
    }

    const total = counter + 2;
    let lastOutput: Buffer<ArrayBufferLike>;
    for (let i = 0; i < total; i++) {
        lastOutput = rfc6979Generate();
    }

    const candidate = bigIntFromBuffer(lastOutput!);
    if (candidate > 0n && candidate < secp256k1.n) {
        return candidate;
    }
    return 0n;
}

function recoverPublicKey(digest: Buffer, r: Buffer, s: Buffer, recoveryId: number): Buffer {
    const n = secp256k1.n;
    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    const e = bigIntFromBuffer(digest) % n;

    if (rBig < 1n || rBig >= n || sBig < 1n || sBig >= n) {
        throw new Error('Invalid signature parameters');
    }

    const isYOdd = recoveryId & 1;
    const recoveryGroup = recoveryId >> 1;
    const x = rBig + BigInt(recoveryGroup) * n;
    if (x >= secp256k1.p) {
        throw new Error('Invalid recovery point');
    }

    const alpha = (x * x * x + secp256k1.a * x + secp256k1.b) % secp256k1.p;
    let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);

    if ((y & 1n) !== BigInt(isYOdd)) {
        y = secp256k1.p - y;
    }

    const R: EcPoint = { x, y };

    const rInv = modInverse(rBig, n);
    const eNeg = (n - (e % n)) % n;
    const sr = ecPointMul(R, sBig);
    const eGNeg = ecPointMul(SECP256K1_BASE_POINT, eNeg);
    const sum = ecPointAdd(sr, eGNeg);
    if (!sum) {
        throw new Error('Failed to recover public key point');
    }
    const Q = ecPointMul(
        sum,
        rInv
    );
    if (!Q) {
        throw new Error('Failed to recover public key');
    }
    return publicKeyFromPoint(Q);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function modInverse(a: bigint, n: bigint): bigint {
    let [t, newT] = [0n, 1n];
    let [r, newR] = [n, a];
    while (newR !== 0n) {
        const quotient = r / newR;
        [t, newT] = [newT, t - quotient * newT];
        [r, newR] = [newR, r - quotient * newR];
    }
    if (r > 1n) throw new Error('modular inverse does not exist');
    if (t < 0n) t += n;
    return t;
}

function ecPointMul(point: EcPoint, scalar: bigint): EcPoint | null {
    if (scalar === 0n) return null;
    if (scalar < 0n) {
        return ecPointMul({ x: point.x, y: secp256k1.p - point.y }, -scalar);
    }

    let result: EcPoint | null = null;
    let addend: EcPoint = { x: point.x, y: point.y };
    let s = scalar;

    while (s > 0n) {
        if (s & 1n) {
            result = result ? ecPointAdd(result, addend) : addend;
        }
        addend = ecPointAdd(addend, addend)!;
        s >>= 1n;
    }
    return result;
}

function ecPointAdd(a: EcPoint | null, b: EcPoint | null): EcPoint | null {
    if (!a) return b;
    if (!b) return a;
    if (a.x === b.x && a.y === b.y) {
        return ecPointDouble(a);
    }
    if (a.x === b.x) return null;

    const p = secp256k1.p;
    const lam = mod((b.y - a.y) * modInverse(mod(b.x - a.x, p), p), p);
    const x = mod(lam * lam - a.x - b.x, p);
    const y = mod(lam * (a.x - x) - a.y, p);

    return { x, y };
}

function ecPointDouble(point: EcPoint): EcPoint {
    const p = secp256k1.p;
    const lam = mod((3n * point.x * point.x + secp256k1.a) * modInverse(mod(2n * point.y, p), p), p);
    const x = mod(lam * lam - 2n * point.x, p);
    const y = mod(lam * (point.x - x) - point.y, p);

    return { x, y };
}

function sign(digest: Buffer, privateKey: Buffer): Buffer {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
        throw new Error('Digest must be 32 bytes');
    }
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }

    const d = bigIntFromBuffer(privateKey);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const nHalf = secp256k1.n >> 1n;
    const pubKeyKnown = privateKeyToPublicKey(privateKey, true);

    const MAX_SIGN_RETRIES = 256;
    let nonce = 0;
    while (nonce < MAX_SIGN_RETRIES) {
        const k = deterministicK(digest, privateKey, nonce);
        const R = ecPointMul(SECP256K1_BASE_POINT, k);
        const rBig = R ? R.x % secp256k1.n : 0n;

        if (!R || rBig === 0n) {
            nonce++;
            continue;
        }

        let sBig = mod(modInverse(k, secp256k1.n) * (e + rBig * d), secp256k1.n);
        if (sBig === 0n) {
            nonce++;
            continue;
        }

        let recoveryId = (R.y & 1n) === 1n ? 1 : 0;
        if (R.x >= secp256k1.n) {
            recoveryId |= 2;
        }
        if (sBig > nHalf) {
            sBig = secp256k1.n - sBig;
            recoveryId ^= 1;
        }

        const rBuf = bufferFromBigInt(rBig, 32);
        const sBuf = bufferFromBigInt(sBig, 32);

        if (!(rBuf[0] < 0x80 && (rBuf[0] !== 0 || rBuf[1] >= 0x80))) {
            nonce++;
            continue;
        }
        if (!(sBuf[0] < 0x80 && (sBuf[0] !== 0 || sBuf[1] >= 0x80))) {
            nonce++;
            continue;
        }

        for (let i = 0; i < 4; i++) {
            try {
                const recovered = recoverPublicKey(digest, rBuf, sBuf, i);
                if (Buffer.isBuffer(recovered) && recovered.equals(pubKeyKnown)) {
                    recoveryId = i;
                    break;
                }
            } catch (err: any) { console.warn('[ecc]', 'recoverPublicKey failed:', getErrorMessage(err)); }
        }
        if (recoveryId < 0 || recoveryId > 3) {
            nonce++;
            continue;
        }

        const compactI = recoveryId + 27 + 4;
        return Buffer.concat([Buffer.from([compactI]), rBuf, sBuf]);
    }
    throw new Error(`Failed to produce valid signature after ${MAX_SIGN_RETRIES} retries`);
}

function verify(digest: Buffer, signature: Buffer, publicKey: Buffer | string): boolean {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
        throw new Error('Digest must be 32 bytes');
    }

    let r: Buffer;
    let s: Buffer;
    if (signature.length === 65) {
        r = signature.slice(1, 33);
        s = signature.slice(33, 65);
    } else if (signature.length === 64) {
        r = signature.slice(0, 32);
        s = signature.slice(32, 64);
    } else {
        throw new Error('Invalid signature length: ' + signature.length);
    }

    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    if (rBig <= 0n || rBig >= secp256k1.n || sBig <= 0n || sBig >= secp256k1.n) {
        return false;
    }

    const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, 'hex');
    const Q = pointFromPublicKey(pubBuf);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const w = modInverse(sBig, secp256k1.n);
    const u1 = mod(e * w, secp256k1.n);
    const u2 = mod(rBig * w, secp256k1.n);
    const point = ecPointAdd(
        ecPointMul(SECP256K1_BASE_POINT, u1),
        ecPointMul(Q, u2)
    );

    if (!point) {
        return false;
    }

    return mod(point.x, secp256k1.n) === rBig;
}

function buildPublicKeyDer(compressedPub: Buffer): Buffer {
    let point: Buffer;
    if (compressedPub.length === 64) {
        point = Buffer.concat([Buffer.from([0x04]), compressedPub]);
    } else if (compressedPub.length === 33) {
        const prefix = compressedPub[0];
        const x = bigIntFromBuffer(compressedPub.slice(1, 33));
        const x3 = x * x * x;
        const ySq = (x3 + secp256k1.b) % secp256k1.p;
        let y = modPow(ySq, (secp256k1.p + 1n) / 4n, secp256k1.p);
        const isOdd = (prefix === 0x03);
        if ((y & 1n) !== BigInt(isOdd)) {
            y = secp256k1.p - y;
        }
        point = Buffer.concat([
            Buffer.from([0x04]),
            bufferFromBigInt(x, 32),
            bufferFromBigInt(y, 32),
        ]);
    } else if (compressedPub.length === 65) {
        point = compressedPub;
    } else {
        throw new Error('Unsupported public key length: ' + compressedPub.length);
    }

    const seqHeader = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
    return Buffer.concat([seqHeader, point]);
}

function buildSignatureDer(r: Buffer, s: Buffer): Buffer {
    const encodeInt = (buf: Buffer): Buffer => {
        let data = buf;
        if (data[0] & 0x80) {
            data = Buffer.concat([Buffer.from([0x00]), data]);
        }
        return Buffer.concat([
            Buffer.from([0x02, data.length]),
            data,
        ]);
    };

    const rEnc = encodeInt(r);
    const sEnc = encodeInt(s);

    return Buffer.concat([
        Buffer.from([0x30, rEnc.length + sEnc.length]),
        rEnc,
        sEnc,
    ]);
}

function wifEncode(privateKey: Buffer, compressed = true): string {
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }
    const prefix = Buffer.from([0x80]);
    let payload = Buffer.concat([prefix, privateKey]);
    if (compressed) {
        payload = Buffer.concat([payload, Buffer.from([0x01])]);
    }
    return base58CheckEncode(payload);
}

function wifDecode(wif: string): WifDecodeResult {
    const payload = base58CheckDecode(wif);
    if (!payload || payload.length < 33) {
        throw new Error('Invalid WIF: too short');
    }
    if (payload[0] !== 0x80) {
        throw new Error('Invalid WIF: wrong version byte');
    }
    const compressed = payload.length === 34 && payload[33] === 0x01;
    const privateKey = payload.slice(1, 33);
    if (!isValidPrivateKey(privateKey)) {
        throw new Error('Invalid WIF: invalid private key');
    }
    return { privateKey, compressed };
}

function base58Encode(buf: Buffer): string {
    return _base58Encode(buf);
}

function base58Decode(str: string): Buffer {
    return Buffer.from(_base58Decode(str));
}

function base58CheckEncode(payload: Buffer): string {
    const checksum = hash256(payload).slice(0, 4);
    return base58Encode(Buffer.concat([payload, checksum]));
}

function base58CheckDecode(str: string): Buffer {
    const decoded = base58Decode(str);
    if (decoded.length < 4) throw new Error('Invalid base58check: too short');
    const payload = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);
    const expected = hash256(payload).slice(0, 4);
    if (!checksum.equals(expected)) throw new Error('Invalid base58check: checksum mismatch');
    return payload;
}

function normalizeBrainKey(name: string, role: string, password: string): Buffer {
    const combined = `${name} ${role} ${password}`.replace(/\s+/g, ' ').trim();
    return sha256(sha512(combined));
}

function brainKeyToPrivateKey(brainKey: Buffer | string, sequence = 0): Buffer {
    const seq = ` ${sequence}`;
    return sha256(sha512(brainKey + seq));
}

function publicKeyToString(pubKeyBuf: Buffer, addressPrefix = 'BTS'): string {
    const checksum = sha256(pubKeyBuf).slice(0, 4);
    return addressPrefix + base58Encode(Buffer.concat([pubKeyBuf, checksum]));
}

function addressFromPublicKey(pubKeyBuf: Buffer, addressPrefix = 'BTS'): string {
    const hash = ripemd160(sha512(pubKeyBuf));
    const checksum = ripemd160(hash).slice(0, 4);
    return addressPrefix + base58Encode(Buffer.concat([hash, checksum]));
}

export { sha256, sha512, ripemd160, hash160, hash256, randomBytes, generatePrivateKey, isValidPrivateKey, privateKeyToPublicKey, sign, verify, recoverPublicKey, wifEncode, wifDecode, normalizeBrainKey, brainKeyToPrivateKey, publicKeyToString, addressFromPublicKey, publicKeyFromBuffer, base58Encode, base58Decode, base58CheckEncode, base58CheckDecode, buildSignatureDer, buildPublicKeyDer, secp256k1 }

