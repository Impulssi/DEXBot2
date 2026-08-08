import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export type { CryptoProvider, EcPoint, ScryptOptions, Aes256GcmEncryptResult } from './provider.js';
import type { CryptoProvider } from './provider.js';
import { isBrowser } from '../env.js';
import { BrowserCryptoProvider } from './browser_provider.js';
export { BrowserCryptoProvider } from './browser_provider.js';
export { ripemd160 as pureRipemd160 } from './pure_ripemd160.js';
export { scrypt as pureScrypt } from './pure_scrypt.js';
export {
    secp256k1,
    privateKeyToPublicKey as pureSecp256k1Pubkey,
    pointFromPublicKey,
    publicKeyFromPoint,
    ecPointMul,
    ecPointAdd,
    ecPointDouble,
    modPow,
    modInverse,
    mod,
    bigIntFromBuffer,
    bufferFromBigInt,
} from './pure_secp256k1.js';

// ── Singleton accessor (mirrors getStorage() pattern) ────────────────
let _crypto: CryptoProvider | null = null;

export function getCrypto(): CryptoProvider {
    if (!_crypto) {
        if (isBrowser()) {
            _crypto = new BrowserCryptoProvider();
        } else {
            const { NodeCryptoProvider } = require('./node_provider');
            _crypto = new NodeCryptoProvider();
        }
    }
    if (!_crypto) throw new Error('Crypto provider not initialized');
    return _crypto;
}

export function setCrypto(provider: CryptoProvider | null): void {
    _crypto = provider;
}
