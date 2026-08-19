'use strict';

declare const globalThis: any;
declare const process: any;

/**
 * Environment detection — single source of truth for Node-vs-browser.
 *
 * The codebase has both Node-only code paths (CLI launchers, Unix sockets,
 * child_process) and browser-compatible paths (crypto, storage, ecc). The
 * `isBrowser()` / `hasProcess()` pair is the canonical check; prefer these
 * over inline `typeof window` / `typeof process` ternaries.
 */
export function isBrowser(): boolean {
    return typeof globalThis !== 'undefined'
        && typeof globalThis.window !== 'undefined'
        && typeof globalThis.window.document !== 'undefined';
}

export function hasProcess(): boolean {
    return typeof process !== 'undefined'
        && typeof process.execPath === 'string';
}
