

import * as chainKeys from '../chain_keys';
function normalizeBootstrapCredential(credential: any): any {
    if (chainKeys.isVaultSecret(credential)) {
        return credential;
    }

    if (credential && typeof credential === 'object' && typeof credential.vaultKeyHex === 'string') {
        return credential;
    }

    throw new Error('Invalid bootstrap credential payload');
}

export { normalizeBootstrapCredential }

