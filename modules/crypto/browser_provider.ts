import { ripemd160 as pureRipemd160 } from './pure_ripemd160';
import { privateKeyToPublicKey as pureSecp256k1Pubkey } from './pure_secp256k1';
import { scrypt as pureScrypt } from './pure_scrypt';
import type { CryptoProvider, ScryptOptions, Aes256GcmEncryptResult } from './provider';

function toAB(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

function fromAB(ab: ArrayBuffer): Uint8Array {
    return new Uint8Array(ab);
}

function webSubtle(): any {
    if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.subtle) {
        return (globalThis as any).crypto.subtle;
    }
    return null;
}

function getRandomValues(arr: Uint8Array): void {
    if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.getRandomValues) {
        (globalThis as any).crypto.getRandomValues(arr);
        return;
    }
    throw new Error('crypto.getRandomValues not available');
}

export class BrowserCryptoProvider implements CryptoProvider {
    async sha256(data: Uint8Array): Promise<Uint8Array> {
        const subtle = webSubtle();
        if (subtle) {
            return fromAB(await subtle.digest('SHA-256', toAB(data)));
        }
        throw new Error('Web Crypto API not available');
    }

    async sha512(data: Uint8Array): Promise<Uint8Array> {
        const subtle = webSubtle();
        if (subtle) {
            return fromAB(await subtle.digest('SHA-512', toAB(data)));
        }
        throw new Error('Web Crypto API not available');
    }

    async ripemd160(data: Uint8Array): Promise<Uint8Array> {
        return pureRipemd160(data);
    }

    async hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
        const subtle = webSubtle();
        if (subtle) {
            const cryptoKey = await subtle.importKey('raw', toAB(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            return fromAB(await subtle.sign('HMAC', cryptoKey, toAB(data)));
        }
        throw new Error('Web Crypto API not available');
    }

    async privateKeyToPublicKey(privateKey: Uint8Array, compressed = true): Promise<Uint8Array> {
        return pureSecp256k1Pubkey(privateKey, compressed);
    }

    async aes256GcmEncrypt(plaintext: Uint8Array, key: Uint8Array): Promise<Aes256GcmEncryptResult> {
        const subtle = webSubtle();
        if (subtle) {
            const iv = new Uint8Array(12);
            getRandomValues(iv);
            const cryptoKey = await subtle.importKey('raw', toAB(key), { name: 'AES-GCM' }, false, ['encrypt']);
            const encrypted = fromAB(await subtle.encrypt(
                { name: 'AES-GCM', iv: toAB(iv), tagLength: 128 },
                cryptoKey,
                toAB(plaintext),
            ));
            const ciphertext = encrypted.slice(0, encrypted.length - 16);
            const authTag = encrypted.slice(encrypted.length - 16);
            return { ciphertext, authTag, iv };
        }
        throw new Error('Web Crypto API not available');
    }

    async aes256GcmDecrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, authTag: Uint8Array): Promise<Uint8Array> {
        const subtle = webSubtle();
        if (subtle) {
            const cryptoKey = await subtle.importKey('raw', toAB(key), { name: 'AES-GCM' }, false, ['decrypt']);
            const combined = new Uint8Array(ciphertext.length + authTag.length);
            combined.set(ciphertext);
            combined.set(authTag, ciphertext.length);
            return fromAB(await subtle.decrypt(
                { name: 'AES-GCM', iv: toAB(iv), tagLength: 128 },
                cryptoKey,
                toAB(combined),
            ));
        }
        throw new Error('Web Crypto API not available');
    }

    async scrypt(password: Uint8Array, salt: Uint8Array, keyLength: number, options?: ScryptOptions): Promise<Uint8Array> {
        return pureScrypt(password, salt, keyLength, {
            N: options?.N ?? 16384,
            r: options?.r ?? 8,
            p: options?.p ?? 1,
            maxmem: options?.maxmem,
        });
    }

    async hkdf(key: Uint8Array, salt: Uint8Array, info: Uint8Array, keyLength: number): Promise<Uint8Array> {
        const subtle = webSubtle();
        if (subtle) {
            const hkdfKey = await subtle.importKey('raw', toAB(key), { name: 'HKDF', hash: 'SHA-256' }, false, ['deriveBits']);
            return fromAB(await subtle.deriveBits(
                { name: 'HKDF', salt: toAB(salt), info: toAB(info), hash: 'SHA-256' },
                hkdfKey,
                keyLength * 8,
            ));
        }
        throw new Error('Web Crypto API not available');
    }

    async timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            diff |= a[i] ^ b[i];
        }
        return diff === 0;
    }

    async randomBytes(size: number): Promise<Uint8Array> {
        const buf = new Uint8Array(size);
        getRandomValues(buf);
        return buf;
    }
}
