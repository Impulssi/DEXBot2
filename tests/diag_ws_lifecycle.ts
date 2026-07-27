#!/usr/bin/env node
'use strict';

/**
 * Debug: Exercise the bitshares_client connection lifecycle that the market
 * adapter uses (reconnectForCycle → use → disconnectClient) and capture the
 * [ws] debug logs from handleConnectionStatus.
 *
 * Usage: tsx tests/diag_ws_lifecycle.ts [--cycles 3]
 */

const { waitForConnected, disconnectClient, reconnectForCycle, getConnectionStatus } = require('../modules/bitshares_client');
const { getErrorMessage } = require('../modules/utils/errors');

const CYCLES = (() => {
    const idx = process.argv.indexOf('--cycles');
    return idx >= 0 && idx + 1 < process.argv.length ? Math.max(1, parseInt(process.argv[idx + 1], 10) || 3) : 3;
})();

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`${ts()}: [diag] ${msg}`); }

async function cycle(n) {
    log(`── cycle ${n} ──`);

    // Simulate the adapter's reconnectForCycle
    log(`calling reconnectForCycle...`);
    const ok = await reconnectForCycle('diag-cycle');
    log(`reconnectForCycle => ${ok}, ws=${getConnectionStatus()}`);

    if (!ok) {
        log(`reconnect failed, trying full failover`);
        const { _assessFailover } = require('../modules/bitshares_client');
        await _assessFailover('diag-fallback');
    }

    // Simulate an API call: wait for connection and do a quick query
    log(`waiting for connected flag...`);
    try {
        await waitForConnected(10000);
        log(`connected, ws=${getConnectionStatus()}`);
    } catch (err) {
        log(`waitForConnected timed out: ${getErrorMessage(err)}`);
    }

    // Simulate the adapter's disconnectClient at end of cycle
    log(`calling disconnectClient...`);
    await disconnectClient();
    log(`disconnectClient done, ws=${getConnectionStatus()}`);
}

async function main() {
    log(`Connection lifecycle debug — ${CYCLES} cycle(s)`);
    log(`Press Ctrl+C to stop\n`);

    // Initial connect (simulates adapter startup)
    log(`startup: waitForConnected...`);
    try {
        await waitForConnected(30000);
        log(`startup connected, ws=${getConnectionStatus()}`);
    } catch (err) {
        log(`startup connect failed: ${getErrorMessage(err)}`);
    }

    for (let i = 1; i <= CYCLES; i++) {
        await cycle(i);
        if (i < CYCLES) {
            log(`sleeping 5s before next cycle...\n`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }

    log(`\nDone. Check [ws] logs above for connection open/close patterns.`);
    process.exit(0);
}

main().catch((err) => { log(`fatal: ${getErrorMessage(err)}`); process.exit(1); });
