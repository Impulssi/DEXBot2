import { globSync } from 'node:fs';
import { spawnSync } from 'child_process';

// ── Intentionally uses process.env directly, NOT Config ───────────
// This script runs BEFORE any module is loaded — Config's startup
// snapshot doesn't apply here.  NODE_OPTIONS is read, mutated, and
// re-read in the same function; RUN_LIVE_BITSHARES_TESTS is a
// test-only flag with no place in a production Config object.
// ──────────────────────────────────────────────────────────────────

// Suppress Node.js circular dependency warnings across all tests.
// NOTE: Mutating process.env here only affects child node processes spawned
// by spawnSync below; the parent process's env is unchanged after this script
// finishes.
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || '';
if (!process.env.NODE_OPTIONS.includes('--no-warnings')) {
    process.env.NODE_OPTIONS += ' --no-warnings';
}

// Tests that require RUN_LIVE_BITSHARES_TESTS=1 (live blockchain connection).
// They are excluded from `npm test` and run only when the env var is set.
const liveTestFiles = new Set([
  'tests/test_any_pair.ts',
  'tests/test_blockchain_fill_history.ts',
  'tests/test_market_book_xaut.ts',
  'tests/test_market_price.ts',
  'tests/test_trade_history.ts',
  'tests/test_connection_trace.ts',
  'tests/test_unlock_foreign_cred_daemon_live.ts',
]);

const testFiles = globSync(['tests/test_*.ts', 'claw/tests/test_*.ts']).sort();

const runLiveTests = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
let skippedLive = 0;

for (const testFile of testFiles) {
  if (liveTestFiles.has(testFile) && !runLiveTests) {
    skippedLive++;
    continue;
  }

  const run = spawnSync(process.execPath, ['--import', 'tsx', testFile], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  if (run.status !== 0) {
    process.exit(run.status || 1);
  }
}

if (skippedLive > 0) {
  console.log(`\n[SKIPPED ${skippedLive} live test(s) — set RUN_LIVE_BITSHARES_TESTS=1 to run]`);
}
