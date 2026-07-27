export type { CryptoProvider, EcPoint, ScryptOptions, Aes256GcmEncryptResult } from './provider';
import type { CryptoProvider } from './provider';
import { isBrowser } from '../env';
import { BrowserCryptoProvider } from './browser_provider';
export { BrowserCryptoProvider } from './browser_provider';
export { ripemd160 as pureRipemd160 } from './pure_ripemd160';
export { scrypt as pureScrypt } from './pure_scrypt';
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
} from './pure_secp256k1';

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
