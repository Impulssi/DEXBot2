#!/usr/bin/env node
/**
 * Trace the exact connection path taken by pm2.ts → waitForConnected
 * to find where the 30s timeout is consumed.
 */
const http = require('http');
const crypto = require('crypto');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('=== Connection Trace ===\n');

// ── 1. Simulate NodeManager.connectWithTimeout in isolation ──
async function testRawWebSocketNodes() {
  console.log('--- NodeManager-style health checks ---');
  const nodes = [
    'wss://btsws.roelandp.nl/ws',
    'wss://cloud.xbts.io/ws',
    'wss://node.xbts.io/ws',
    'wss://public.xbts.io/ws',
    'wss://dex.iobanker.com/ws',
    'wss://api.dex.trading/',
    'wss://api.bts.mobi/ws',
    'wss://api.btslebin.com/ws',
  ];
  const WS_TIMEOUT_MS = 10000;
  for (const url of nodes) {
    const start = Date.now();
    try {
      const ws = new WebSocket(url);
      let timeout;
      await Promise.race([
        new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = (e) => reject(new Error(getErrorMessage(e) || 'WS error'));
          ws.onclose = (e) => reject(new Error(`close code=${(e as any).code}`));
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`WS timeout after ${WS_TIMEOUT_MS}ms`)), WS_TIMEOUT_MS)
        }),
      ]);
      clearTimeout(timeout);
      const connectMs = Date.now() - start;
      ws.close();
      console.log(`  ✓ ${url}  (${connectMs}ms)`);
    } catch (e) {
      console.log(`  ✗ ${url}  FAIL: ${getErrorMessage(e)}`);
    }
  }
}

// ── 2. Simulate transport.connectOne + validateNode (login RPC) ──
async function testTransportConnectAndLogin(url) {
  console.log('\n--- Transport connectOne + login ---');
  console.log(`  Connecting to: ${url}`);
  const start = Date.now();
  try {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error(getErrorMessage(e) || 'WS error'));
    });
    console.log(`  ✓ WebSocket handshake: ${Date.now() - start}ms`);

    // Now do the login RPC sequence
    let rpcId = 0;
    function rpcCall(method, params) {
      const id = ++rpcId;
      ws.send(JSON.stringify({ id, method: 'call', params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout ${method}`)), 10000);
        ws.onmessage = (msg) => {
          try {
            const resp = JSON.parse(msg.data);
            if (resp.id === id) {
              clearTimeout(timer);
              if (resp.error) reject(new Error(resp.error.message));
              else resolve(resp.result);
            }
          } catch (_) {}
        };
      });
    }

    const rpcStart = Date.now();
    const loginResult = await rpcCall('call', [1, 'login', ['', '']]);
    console.log(`  ✓ login(): ${JSON.stringify(loginResult)} (${Date.now() - rpcStart}ms)`);

    const dbApiId = await rpcCall('call', [1, 'database', []]);
    console.log(`  ✓ database API: id=${dbApiId} (${Date.now() - rpcStart}ms)`);

    const chainId: any = await rpcCall('call', [dbApiId, 'get_chain_id', []]);
    console.log(`  ✓ chain_id: ${chainId.substring(0, 16)}... (${Date.now() - rpcStart}ms)`);

    const props: any = await rpcCall('call', [dbApiId, 'get_chain_properties', []]);
    console.log(`  ✓ chain_properties: prefix=${props?.address_prefix} (${Date.now() - rpcStart}ms)`);

    const globals: any = await rpcCall('call', [dbApiId, 'get_global_properties', []]);
    console.log(`  ✓ global_properties: core=${globals?.parameters?.core_asset} (${Date.now() - rpcStart}ms)`);

    console.log(`  ✓ Full login sequence: ${Date.now() - rpcStart}ms`);
    ws.close();
  } catch (e) {
    console.log(`  ✗ FAIL: ${getErrorMessage(e)}`);
  }
}

// ── 3. Simulate refreshStartupNodeServers → restartBitsharesConnection ──
// by directly loading the modules (in a fresh require context)
async function testModuleConnection() {
  console.log('\n--- Module-level connection (bitshares_client) ---');
  
  // Clear caches to force fresh module load
  for (const key of Object.keys(require.cache)) {
    if (key.includes('bitshares_client') || key.includes('node_manager') || 
        key.includes('general_settings') || key.includes('constants') ||
        key.includes('bitshares-native') || key.includes('subscriptions') ||
        key.includes('resolvers') || key.includes('transport') ||
        key.includes('chain_client')) {
      delete require.cache[key];
    }
  }

  // Capture all warnings and errors during connection
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
    origWarn(...args);
  };

  const t0 = Date.now();
  try {
    const { waitForConnected } = require('../modules/bitshares_client');
    const { TIMING } = require('../modules/constants');
    
    console.log('  Calling waitForConnected...');
    const timeout = Math.min(TIMING.CONNECTION_TIMEOUT_MS, 45000);
    await waitForConnected(timeout);
    console.log(`  ✓ Connected in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`  ✗ waitForConnected failed after ${Date.now() - t0}ms: ${getErrorMessage(e)}`);
    console.log(`  Warnings (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`    ${w}`);
    }
  } finally {
    console.warn = origWarn;
  }
}

const TRACE_TIMEOUT_MS = Number(process.env.BITSHARES_TRACE_TIMEOUT_MS) || 60000;
let traceTimer;
(async () => {
  traceTimer = setTimeout(() => {
    console.error(`\nTrace timed out after ${TRACE_TIMEOUT_MS}ms`);
    process.exit(1);
  }, TRACE_TIMEOUT_MS);

  try {
    await testRawWebSocketNodes();
    await testTransportConnectAndLogin('wss://btsws.roelandp.nl/ws');
    await testModuleConnection();
    clearTimeout(traceTimer);
    console.log('\n=== Trace complete ===');
    process.exit(0);
  } catch (e) {
    clearTimeout(traceTimer);
    console.error('Trace error:', getErrorMessage(e));
    process.exit(1);
  }
})();
