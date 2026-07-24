// Must be before any require() due to config caching trap
const ORIG_ENV: Record<string, string | undefined> = {};
for (const k of ['DEXBOT_PROFILE_ROOT', 'DEXBOT2_ROOT'] as const) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('Running paths tests');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-test-paths-'));

// ── Test helpers ────────────────────────────────────────────────────────

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
    const snap: EnvSnapshot = {};
    for (const k of keys) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnapshot) {
    for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

// Clear paths module from cache so the next require() re-evaluates
function freshPaths() {
    delete require.cache[require.resolve('../modules/paths')];
    // Also clear config.ts since paths depends on it
    delete require.cache[require.resolve('../modules/config')];
    return require('../modules/paths');
}

let passed = 0;
let total = 0;

function check(label: string, ok: boolean, detail?: string) {
    total++;
    if (ok) { passed++; console.log(`  ✓ ${label}`); }
    else console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── 1) DEXBOT_PROFILE_ROOT env var → returned directly ─────────────────
try {
    const testRoot1 = fs.mkdtempSync(path.join(tmpRoot, 'root-test-'));
    process.env.DEXBOT_PROFILE_ROOT = testRoot1;

    const p1 = freshPaths();
    check('DEXBOT_PROFILE_ROOT takes priority',
        p1.PATHS.PROFILES_DIR === testRoot1,
        `expected ${testRoot1}, got ${p1.PATHS.PROFILES_DIR}`);
} finally {
    restoreEnv({ DEXBOT_PROFILE_ROOT: ORIG_ENV.DEXBOT_PROFILE_ROOT });
}

// ── 2) DEXBOT2_ROOT env var → path/DEXBOT2_ROOT/profiles ───────────────
try {
    const testRoot2 = fs.mkdtempSync(path.join(tmpRoot, 'root2-test-'));
    process.env.DEXBOT2_ROOT = testRoot2;

    const p2 = freshPaths();
    const want = path.join(testRoot2, 'profiles');
    check('DEXBOT2_ROOT appends /profiles',
        p2.PATHS.PROFILES_DIR === want,
        `expected ${want}, got ${p2.PATHS.PROFILES_DIR}`);
} finally {
    restoreEnv({ DEXBOT2_ROOT: ORIG_ENV.DEXBOT2_ROOT });
}

// ── 3) Neither env var → PROJECT_ROOT/profiles ─────────────────────────
// At this point both env vars are cleared (line 1) and never restored.
const p3 = freshPaths();
check('Default resolves to PROJECT_ROOT/profiles',
    p3.PATHS.PROFILES_DIR.endsWith(path.join('profiles')),
    p3.PATHS.PROFILES_DIR);

// ── 4) resolveProfilesDir is exported ──────────────────────────────────
check('resolveProfilesDir is exported',
    typeof p3.resolveProfilesDir === 'function');

// ── 5) Exported function is callable and returns a string ──────────────
const dir = p3.resolveProfilesDir();
check('resolveProfilesDir returns a string',
    typeof dir === 'string' && dir.length > 0,
    dir);

// ── Summary ────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n✓ ${passed}/${total} paths tests passed`);
