

import * as chainKeys from '../chain_keys.js';
function normalizeBootstrapCredential(credential: unknown): unknown {
    if (chainKeys.isVaultSecret(credential)) {
        return credential;
    }

    if (credential && typeof credential === 'object' && typeof (credential as { vaultKeyHex?: unknown }).vaultKeyHex === 'string') {
        return credential;
    }

    throw new Error('Invalid bootstrap credential payload');
}

export { normalizeBootstrapCredential }

