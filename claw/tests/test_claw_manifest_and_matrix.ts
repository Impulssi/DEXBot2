'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// claw_runtime_matrix
// ---------------------------------------------------------------------------

function testRuntimeMatrix() {
  const matrix = require('../modules/claw_runtime_matrix');

  const all = matrix.listSupportedClawRuntimes();
  assert.ok(all.length >= 9);

  const names = all.map((r: any) => r.runtime);
  assert.deepStrictEqual(names, ['openclaw', 'hermes', 'openfang', 'nanobot', 'picoclaw', 'nanoclaw', 'zeroclaw', 'nullclaw', 'memu']);

  // Each entry is a defensive clone — mutations must not affect the registry
  all[0].runtime = 'mutated';
  assert.notStrictEqual(matrix.listSupportedClawRuntimes()[0].runtime, 'mutated');

  // Known runtime lookup
  const zc = matrix.getSupportedClawRuntime('zeroclaw');
  assert.strictEqual(zc.runtime, 'zeroclaw');
  assert.strictEqual(zc.preferredTransport, 'local-cli-json');
  assert.strictEqual(zc.skillFile, 'SKILL.toml');

  const of = matrix.getSupportedClawRuntime('openfang');
  assert.strictEqual(of.runtime, 'openfang');
  assert.strictEqual(of.preferredTransport, 'local-cli-json');
  assert.strictEqual(of.skillFile, 'SKILL.md');

  const hermes = matrix.getSupportedClawRuntime('hermes');
  assert.strictEqual(hermes.runtime, 'hermes');
  assert.strictEqual(hermes.preferredTransport, 'mcp-stdio-jsonl');
  assert.strictEqual(hermes.skillFile, 'SKILL.md');
  assert.ok(hermes.notes.includes('~/.hermes/config.yaml'));

  const nb = matrix.getSupportedClawRuntime('nanobot');
  assert.strictEqual(nb.runtime, 'nanobot');
  assert.strictEqual(nb.preferredTransport, 'mcp-stdio-jsonl');
  assert.ok(nb.notes.includes('newline-delimited JSON-RPC'));

  const pc = matrix.getSupportedClawRuntime('picoclaw');
  assert.strictEqual(pc.runtime, 'picoclaw');
  assert.strictEqual(pc.preferredTransport, 'mcp-stdio-jsonl');
  assert.ok(pc.notes.includes('newline-delimited JSON-RPC'));

  const nanoclaw = matrix.getSupportedClawRuntime('nanoclaw');
  assert.strictEqual(nanoclaw.runtime, 'nanoclaw');
  assert.strictEqual(nanoclaw.preferredTransport, 'local-cli-json');
  assert.strictEqual(nanoclaw.skillFile, 'SKILL.md');

  const nullclaw = matrix.getSupportedClawRuntime('nullclaw');
  assert.strictEqual(nullclaw.runtime, 'nullclaw');
  assert.strictEqual(nullclaw.preferredTransport, 'skill-toml-or-mcp');
  assert.strictEqual(nullclaw.skillFile, 'SKILL.toml');

  const memu = matrix.getSupportedClawRuntime('memu');
  assert.strictEqual(memu.runtime, 'memu');
  assert.strictEqual(memu.preferredTransport, 'local-cli-json-or-mcp');
  assert.strictEqual(memu.skillFile, 'SKILL.md');

  // Lookup is case-insensitive and trims whitespace
  assert.strictEqual(matrix.getSupportedClawRuntime('  ZeroClaw  ').runtime, 'zeroclaw');
  assert.strictEqual(matrix.getSupportedClawRuntime('OPENCLAW').runtime, 'openclaw');
  assert.strictEqual(matrix.getSupportedClawRuntime('NullClaw').runtime, 'nullclaw');
  assert.strictEqual(matrix.getSupportedClawRuntime('MEMU').runtime, 'memu');

  // Unknown / missing runtime returns null
  assert.strictEqual(matrix.getSupportedClawRuntime('unknown'), null);
  assert.strictEqual(matrix.getSupportedClawRuntime(''), null);
  assert.strictEqual(matrix.getSupportedClawRuntime(null), null);
  assert.strictEqual(matrix.getSupportedClawRuntime(undefined), null);
}

// ---------------------------------------------------------------------------
// claw_manifest
// ---------------------------------------------------------------------------

function testClawManifest() {
  const manifest = require('../modules/claw_manifest');

  const desc = manifest.describeClawBridge();

  // Top-level shape
  assert.ok(desc.compatibility);
  assert.ok(desc.commands);
  assert.ok(desc.tools);
  assert.ok(desc.surfaces);
  assert.strictEqual(desc.surfaces.settings, undefined);

  // Identity
  assert.strictEqual(desc.compatibility.name, 'Claw');
  assert.strictEqual(desc.compatibility.version, 2);
  assert.ok(desc.surfaces.profiles.includes('bot settings'));

  // Commands list is non-empty and consistent with catalog
  assert.ok(Array.isArray(desc.commands));
  assert.ok(desc.commands.length > 0);
  assert.ok(desc.commands.includes('manifest'));
  assert.ok(desc.commands.includes('create-limit-order'));
  assert.ok(desc.commands.includes('bot-settings-apply'));
  assert.ok(desc.commands.includes('memu-status'));
  assert.ok(desc.commands.includes('memu-create-item'));
  assert.ok(desc.surfaces.memory.includes('memU'));

  // byRisk grouping covers at least read and execute buckets
  assert.ok(Array.isArray(desc.tools.byRisk.read));
  assert.ok(Array.isArray(desc.tools.byRisk.execute));

  // catalog array matches commands list length
  assert.strictEqual(desc.tools.catalog.length, desc.commands.length);

  // Runtime-focused call sets recommendedTransport from the matrix
  const zcDesc = manifest.describeClawBridge({ runtimeName: 'zeroclaw' });
  assert.strictEqual(zcDesc.compatibility.recommendedTransport, 'local-cli-json');
  assert.strictEqual(zcDesc.options.runtimeName, 'zeroclaw');

  const nbDesc = manifest.describeClawBridge({ runtimeName: 'nanobot' });
  assert.strictEqual(nbDesc.compatibility.recommendedTransport, 'mcp-stdio-jsonl');
  assert.strictEqual(nbDesc.options.runtimeName, 'nanobot');

  const hermesDesc = manifest.describeClawBridge({ runtimeName: 'hermes' });
  assert.strictEqual(hermesDesc.compatibility.recommendedTransport, 'mcp-stdio-jsonl');
  assert.strictEqual(hermesDesc.options.runtimeName, 'hermes');

  const openfangDesc = manifest.describeClawBridge({ runtimeName: 'openfang' });
  assert.strictEqual(openfangDesc.compatibility.recommendedTransport, 'local-cli-json');
  assert.strictEqual(openfangDesc.options.runtimeName, 'openfang');

  const nanoclawDesc = manifest.describeClawBridge({ runtimeName: 'nanoclaw' });
  assert.strictEqual(nanoclawDesc.compatibility.recommendedTransport, 'local-cli-json');
  assert.strictEqual(nanoclawDesc.options.runtimeName, 'nanoclaw');

  // Unknown runtime falls back gracefully
  const unknownDesc = manifest.describeClawBridge({ runtimeName: 'unknown' });
  assert.strictEqual(unknownDesc.compatibility.recommendedTransport, 'runtime-specific');
  assert.strictEqual(unknownDesc.options.runtimeName, null);

  // Options are passed through
  const withOpts = manifest.describeClawBridge({
    accountName: 'alice',
    profileRoot: '/tmp/profiles',
    socketPath: '/tmp/cred.sock'
  });
  assert.strictEqual(withOpts.options.accountName, 'alice');
  assert.strictEqual(withOpts.options.profileRoot, '/tmp/profiles');
  assert.strictEqual(withOpts.options.socketPath, '/tmp/cred.sock');
}

// ---------------------------------------------------------------------------
// dexbot_bridge — getDexbot2Root branching only
// ---------------------------------------------------------------------------

// Repo root located independently of the compiled layout: compiled tests run
// from <repo>/dist/claw/tests, so a fixed __dirname offset would point at
// dist/ instead of the repo. The repo root is the nearest ancestor holding
// package.json plus both the modules/ and claw/ source trees.
function findRepoRoot(startDir: string) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'modules')) &&
      fs.existsSync(path.join(dir, 'claw'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Unable to locate DEXBot2 repo root');
}

function testDexbotBridgeRootResolution() {
  const bridgePath = require.resolve('../modules/dexbot_bridge');
  const { Config } = require('../../modules/config');

  // --- Branch 1: DEXBOT2_ROOT is set ---
  // Config.DEXBOT2_ROOT is a snapshot taken at module load time,
  // so tests must mutate Config directly rather than process.env.
  delete require.cache[bridgePath];
  const savedRoot = Config.DEXBOT2_ROOT;
  Config.DEXBOT2_ROOT = '/custom/dexbot2';
  try {
    const bridge = require('../modules/dexbot_bridge');
    assert.strictEqual(bridge.getDexbot2Root(), path.resolve('/custom/dexbot2'));
  } finally {
    Config.DEXBOT2_ROOT = savedRoot;
    delete require.cache[bridgePath];
  }

  // --- Branch 2: no DEXBOT2_ROOT, auto-detected local repo layout ---
  // The test runs inside the DEXBot2 repo, so the existsSync candidate check
  // (dist/modules/order/index.js) should resolve to the repo root itself.
  delete require.cache[bridgePath];
  Config.DEXBOT2_ROOT = undefined;
  try {
    const bridge = require('../modules/dexbot_bridge');
    const root = bridge.getDexbot2Root();
    const expectedRoot = findRepoRoot(__dirname);
    assert.strictEqual(root, expectedRoot);
  } finally {
    Config.DEXBOT2_ROOT = savedRoot;
    delete require.cache[bridgePath];
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  testRuntimeMatrix();
  testClawManifest();
  testDexbotBridgeRootResolution();
  console.log('claw manifest and matrix tests passed');
}

main();
