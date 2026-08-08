
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { isBrowser } from '../../env.js';
'use strict';


/**
 * ECC module selector — picks the browser-safe or Node implementation.
 *
 * The three production load sites (bitshares-native/index.ts, tx/builder.ts,
 * signing_client.ts) all used to inline the same `typeof globalThis.window`
 * ternary. Centralizing here keeps the swap in one place and makes the
 * browser-safe surface auditable in a single grep.
 *
 * Exposed as a function (not a const) so callers that need lazy loading —
 * e.g. signing_client.wifToBuffer, which is on a read-only hot path —
 * can defer the require until first use.
 */
function getEcc(): any {
    return isBrowser() ? require('./ecc.browser') : require('./ecc');
}

export default getEcc
