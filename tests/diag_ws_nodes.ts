#!/usr/bin/env node
'use strict';

/**
 * Diagnostic: WebSocket node connectivity and stability test.
 *
 * Tests each BitShares node with the exact operations the market adapter
 * performs every cycle for the IOB.XRP/BTS pair (liquidity pool 1.19.133):
 *   1. Handshake + login + API registration + chain-ID validation
 *   2. Asset lookup (IOB.XRP + BTS)
 *   3. Liquidity pool query (1.19.133)
 *   4. Pool swap history (get_liquidity_pool_history)
 *   5. Orderbook market history (getMarketHistory — the book-source path)
 *   6. Connection stability hold
 *
 * Usage: tsx tests/diag_ws_nodes.ts [--quick] [--stability-s 60]
 */

const _WebSocket = globalThis.WebSocket;
const { NODE_MANAGEMENT } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

const EXPECTED_CHAIN_ID = NODE_MANAGEMENT.EXPECTED_CHAIN_ID;
const NODES = NODE_MANAGEMENT.DEFAULT_NODES;
const CONNECT_TIMEOUT = 10000;
const RPC_TIMEOUT = 15000;
const POOL_ID = '1.19.133';
const ASSET_A = 'IOB.XRP';
const ASSET_B = 'BTS';

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const STABILITY_S = (() => {
    const idx = args.indexOf('--stability-s');
    return idx >= 0 && idx + 1 < args.length ? Math.max(1, parseInt(args[idx + 1], 10) || 30) : 30;
})();

// ── Helpers ──────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`${ts()}: ${msg}`); }

function wsConnect(nodeUrl, timeoutMs = CONNECT_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const ws = new _WebSocket(nodeUrl);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error(`handshake timeout ${timeoutMs}ms`));
        }, timeoutMs);
        ws.onopen = () => { clearTimeout(timer); resolve(ws); };
        ws.onerror = () => {};
        ws.onclose = (evt) => {
            clearTimeout(timer);
            reject(new Error(`handshake closed code=${evt.code} reason=${evt.reason || '(none)'}`));
        };
    });
}

let _rpcId = 1;
function rpc(ws, method, params, timeoutMs = RPC_TIMEOUT) {
    const id = _rpcId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`RPC timeout ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (raw) => {
            try {
                const msg = JSON.parse(raw.data);
                if (String(msg.id) === String(id)) {
                    clearTimeout(timer);
                    ws.removeEventListener('message', handler);
                    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            } catch (_) {}
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
    });
}

// ── Node test ────────────────────────────────────────────────────────────
async function testNode(nodeUrl, index) {
    const label = `[${index + 1}/${NODES.length}] ${nodeUrl.substring(0, 48)}`;
    const result = { nodeUrl, ok: true, checks: [], lifespanS: null, dropReason: null };
    log(`\n${label}`);

    // ── 1. Connect ───────────────────────────────────────────────────────
    let ws;
    const t0 = Date.now();
    try {
        ws = await wsConnect(nodeUrl, CONNECT_TIMEOUT);
        log(`  connect ✓ (${Date.now() - t0}ms)`);
        result.checks.push('connect');
    } catch (err) {
        log(`  connect ✗ ${getErrorMessage(err)}`);
        result.ok = false; (result as any).error = `connect: ${getErrorMessage(err)}`;
        return result;
    }

    // ── 2. Login + API registration ──────────────────────────────────────
    let dbId, historyId;
    try {
        await rpc(ws, 'call', [1, 'login', ['', '']]);
        dbId = await rpc(ws, 'call', [1, 'database', []]);
        historyId = await rpc(ws, 'call', [1, 'history', []]);
        log(`  login ✓ (db=${dbId} history=${historyId})`);
        result.checks.push('login');
    } catch (err) {
        log(`  login ✗ ${getErrorMessage(err)}`);
        result.ok = false; (result as any).error = `login: ${getErrorMessage(err)}`;
        try { ws.close(); } catch (_) {} return result;
    }

    // ── 3. Chain ID ──────────────────────────────────────────────────────
    try {
        const chainId = await rpc(ws, 'call', [dbId, 'get_chain_id', []]);
        if (chainId === EXPECTED_CHAIN_ID) {
            result.checks.push('chain');
        } else {
            throw new Error(`wrong chain ${String(chainId).substring(0, 20)}...`);
        }
    } catch (err) {
        log(`  chain ✗ ${getErrorMessage(err)}`);
        result.ok = false; (result as any).error = `chain: ${getErrorMessage(err)}`;
        try { ws.close(); } catch (_) {} return result;
    }
    log(`  chain ✓`);

    // ── 4. Asset lookup ──────────────────────────────────────────────────
    let assetAId, assetBId;
    try {
        const symbols = await rpc(ws, 'call', [dbId, 'lookup_asset_symbols', [[ASSET_A, ASSET_B]]]);
        const by = {}; for (const a of (symbols as any)) by[a.symbol] = a;
        if (!by[ASSET_A] || !by[ASSET_B]) throw new Error(`missing: ${(symbols as any).map((s) => s.symbol).join(',')}`);
        assetAId = by[ASSET_A].id;
        assetBId = by[ASSET_B].id;
        log(`  assets ✓ ${ASSET_A}=${assetAId} ${ASSET_B}=${assetBId}`);
        result.checks.push('assets');
    } catch (err) {
        log(`  assets ✗ ${getErrorMessage(err)}`);
        result.ok = false; (result as any).error = `assets: ${getErrorMessage(err)}`;
        try { ws.close(); } catch (_) {} return result;
    }

    // ── 5. Pool swap history (liquidity pool path) ───────────────────────
    try {
        const ops = await rpc(ws, 'call', [historyId, 'get_liquidity_pool_history', [POOL_ID, null, null, 5, 1]]);
        const count = Array.isArray(ops) ? ops.length : 0;
        log(`  pool-swaps ✓ ${count} recent`);
        result.checks.push('pool-swaps');
    } catch (err) {
        log(`  pool-swaps ✗ ${getErrorMessage(err)}`);
        result.ok = false; (result as any).error = `pool-swaps: ${getErrorMessage(err)}`;
        try { ws.close(); } catch (_) {} return result;
    }

    // ── 6. Market history (orderbook path) ───────────────────────────────
    try {
        const now = new Date();
        const start = new Date(now.getTime() - 3600 * 1000);
        const history = await rpc(ws, 'call', [historyId, 'get_market_history', [
            assetBId, assetAId, 3600,
            start.toISOString().slice(0, -5),
            now.toISOString().slice(0, -5),
        ]]);
        const count = Array.isArray(history) ? history.length : 0;
        log(`  book-candles ✓ ${count} buckets`);
        result.checks.push('book-candles');
    } catch (err) {
        log(`  book-candles ✗ ${getErrorMessage(err)}`);
        result.ok = false; (result as any).error = `book-candles: ${getErrorMessage(err)}`;
        try { ws.close(); } catch (_) {} return result;
    }

    // ── 7. Stability test ────────────────────────────────────────────────
    if (QUICK) {
        log(`  stability (skipped)`);
        try { ws.close(); } catch (_) {}
        return result;
    }

    let dropped = false;
    const stabilityStart = Date.now();
    ws.addEventListener('close', (evt) => {
        if (!dropped) {
            dropped = true;
            result.dropReason = `code=${evt.code} reason=${evt.reason || '(none)'}`;
        }
    });

    log(`  stability holding for up to ${STABILITY_S}s...`);
    await new Promise((resolve) => {
        const check = () => {
            if (dropped) {
                result.lifespanS = ((Date.now() - stabilityStart) / 1000).toFixed(1);
                log(`  stability ✗ DROPPED after ${result.lifespanS}s (${result.dropReason})`);
                resolve(undefined); return;
            }
            if ((Date.now() - stabilityStart) / 1000 >= STABILITY_S) {
                result.lifespanS = `>${STABILITY_S}`;
                log(`  stability ✓ held ${STABILITY_S}s`);
                try { ws.close(); } catch (_) {}
                resolve(undefined); return;
            }
            setTimeout(check, 1000);
        };
        setTimeout(check, 1000);
    });

    if (dropped) result.ok = false;
    return result;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
    log('═══════════════════════════════════════════');
    log(` Node Connectivity Diagnostic`);
    log(` Nodes: ${NODES.length}`);
    log(` Pair: ${ASSET_A}/${ASSET_B} | Pool: ${POOL_ID}`);
    log(` Tests: connect → login → chain → assets → pool-swaps → book-candles${QUICK ? '' : ` → hold ${STABILITY_S}s`}`);
    log('═══════════════════════════════════════════');

    const results = [];
    for (let i = 0; i < NODES.length; i++) {
        results.push(await testNode(NODES[i], i));
    }

    console.log('\n═══════════════════════════════════════════');
    console.log(' SUMMARY');
    console.log('═══════════════════════════════════════════');

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    console.log(`  Full pass: ${ok.length}/${results.length}`);
    console.log(`  Failed:    ${failed.length}/${results.length}`);

    if (ok.length > 0) {
        console.log('\n  ✓ Full pass:');
        ok.forEach((r) => console.log(`    ${r.nodeUrl}  [${r.checks.join(', ')}]`));
    }

    if (failed.length > 0) {
        console.log('\n  ✗ Failed:');
        for (const r of failed) {
            const detail = [];
            if (r.error) detail.push(r.error);
            if (r.dropReason) detail.push(`stability: ${r.dropReason} @ ${r.lifespanS}s`);
            console.log(`    ${r.nodeUrl}  → ${detail.join(' | ')}`);
        }
    }

    // Highlight unstable nodes (pass all API checks but drop during stability)
    const droppedOk = results.filter((r) => r.dropReason && r.checks.length >= 6);
    if (droppedOk.length > 0) {
        console.log('\n  ⚠ Passed all API checks but dropped during stability hold:');
        for (const r of droppedOk) {
            console.log(`    ${r.nodeUrl}  → dropped at ${r.lifespanS}s (${r.dropReason})`);
        }
        console.log('  This is the exact pattern causing adapter "readyState 3 (CLOSED)" errors.');
        console.log('  These nodes have short idle-timeout policies (likely behind a proxy/LB).');
    }

    if (ok.length === 0) {
        console.log('\n  ALL nodes failed. Check network / firewall.');
    }

    console.log('');
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => { console.error(`Fatal: ${getErrorMessage(err)}`); process.exit(2); });
