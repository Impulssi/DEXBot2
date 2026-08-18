// Must be before any require() due to config caching trap
const ORIG_ENV: Record<string, string | undefined> = {};
for (const k of ['DEXBOT_PROFILE_ROOT', 'DEXBOT2_ROOT', 'DEXBOT_MARKET_ADAPTER_DATA_DIR', 'DEXBOT_MARKET_ADAPTER_STATE_DIR', 'DEXBOT_CLAW_DATA_DIR'] as const) {
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

// ── 6) isGlobalNpmPackageDir detection ────────────────────────────────
{
    const p6 = freshPaths();
    const npmLike = path.join(tmpRoot, 'node_modules', 'dexbot');
    check('isGlobalNpmPackageDir detects node_modules paths',
        p6.isGlobalNpmPackageDir(npmLike) === true);
    check('isGlobalNpmPackageDir rejects plain paths',
        p6.isGlobalNpmPackageDir(tmpRoot) === false);
}

// ── 7) Global npm install → home-based profiles default ──────────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'npm-home-'));
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    fs.mkdirSync(homeProfiles, { recursive: true });
    fs.writeFileSync(path.join(homeProfiles, 'bots.json'), '{}');
    const fakeNpmRoot = path.join(fakeHome, 'node_modules', 'dexbot');

    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
        const p7 = freshPaths();
        check('npm install defaults to ~/.config/dexbot2/profiles',
            p7.resolveProfilesDir(fakeNpmRoot) === homeProfiles,
            `expected ${homeProfiles}, got ${p7.resolveProfilesDir(fakeNpmRoot)}`);
    } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 8) Market adapter dirs: source layout when market_adapter exists ──
{
    const p8 = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const ma = p8.resolveMarketAdapterDirs(tmpRoot, repoRoot);
    check('source checkout keeps PROJECT_ROOT/market_adapter data',
        ma.DATA_DIR === path.join(repoRoot, 'market_adapter', 'data'),
        ma.DATA_DIR);
    check('source checkout keeps PROJECT_ROOT/market_adapter state',
        ma.STATE_DIR === path.join(repoRoot, 'market_adapter', 'state'),
        ma.STATE_DIR);
}

// ── 9) Market adapter dirs: relocated under profiles for npm installs ─
{
    const p9 = freshPaths();
    const fakeNpmRoot = path.join(tmpRoot, 'node_modules', 'dexbot');
    const ma = p9.resolveMarketAdapterDirs(tmpRoot, fakeNpmRoot);
    const wantData = path.join(tmpRoot, 'market_adapter', 'data');
    const wantState = path.join(tmpRoot, 'market_adapter', 'state');
    check('npm install relocates market adapter data under profiles',
        ma.DATA_DIR === wantData,
        `expected ${wantData}, got ${ma.DATA_DIR}`);
    check('npm install relocates market adapter state under profiles',
        ma.STATE_DIR === wantState,
        `expected ${wantState}, got ${ma.STATE_DIR}`);
}

// ── 10) Market adapter dirs: env vars override everything ────────────
{
    const p10 = freshPaths();
    const cfg = require('../modules/config').Config;
    const dataOverride = path.join(tmpRoot, 'custom-ma-data');
    const stateOverride = path.join(tmpRoot, 'custom-ma-state');
    const savedData = cfg.DEXBOT_MARKET_ADAPTER_DATA_DIR;
    const savedState = cfg.DEXBOT_MARKET_ADAPTER_STATE_DIR;
    try {
        cfg.DEXBOT_MARKET_ADAPTER_DATA_DIR = dataOverride;
        cfg.DEXBOT_MARKET_ADAPTER_STATE_DIR = stateOverride;
        const ma = p10.resolveMarketAdapterDirs(tmpRoot, path.resolve(__dirname, '..'));
        check('DEXBOT_MARKET_ADAPTER_DATA_DIR overrides data root',
            ma.DATA_DIR === dataOverride,
            `expected ${dataOverride}, got ${ma.DATA_DIR}`);
        check('DEXBOT_MARKET_ADAPTER_STATE_DIR overrides state root',
            ma.STATE_DIR === stateOverride,
            `expected ${stateOverride}, got ${ma.STATE_DIR}`);
        check('LP dir derives from overridden data root',
            ma.LP_DATA_DIR === path.join(dataOverride, 'lp'));
    } finally {
        cfg.DEXBOT_MARKET_ADAPTER_DATA_DIR = savedData;
        cfg.DEXBOT_MARKET_ADAPTER_STATE_DIR = savedState;
    }
}

// ── 11) Claw data dirs: source checkout keeps PROJECT_ROOT/claw/data ──
{
    const p11 = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const claw = p11.resolveClawDirs(tmpRoot, repoRoot);
    check('source checkout keeps PROJECT_ROOT/claw data',
        claw.DATA_DIR === path.join(repoRoot, 'claw', 'data'),
        claw.DATA_DIR);
    check('source checkout keeps positions under claw data',
        claw.POSITIONS_FILE === path.join(repoRoot, 'claw', 'data', 'positions.json'),
        claw.POSITIONS_FILE);
}

// ── 12) Claw data dirs: relocated under profiles for npm installs ────
{
    const p12 = freshPaths();
    const fakeNpmRoot = path.join(tmpRoot, 'node_modules', 'dexbot');
    const claw = p12.resolveClawDirs(tmpRoot, fakeNpmRoot);
    const wantData = path.join(tmpRoot, 'claw', 'data');
    check('npm install relocates claw data under profiles',
        claw.DATA_DIR === wantData,
        `expected ${wantData}, got ${claw.DATA_DIR}`);
    check('npm install relocates positions under profiles claw data',
        claw.POSITIONS_FILE === path.join(wantData, 'positions.json'),
        claw.POSITIONS_FILE);
    check('npm install keeps claw code at PROJECT_ROOT',
        claw.DIR === fakeNpmRoot + path.sep + 'claw',
        claw.DIR);
}

// ── 13) Claw data dir: env var overrides layout ─────────────────────
{
    const p13 = freshPaths();
    const cfg = require('../modules/config').Config;
    const dataOverride = path.join(tmpRoot, 'custom-claw-data');
    const saved = cfg.DEXBOT_CLAW_DATA_DIR;
    try {
        cfg.DEXBOT_CLAW_DATA_DIR = dataOverride;
        const claw = p13.resolveClawDirs(tmpRoot, path.resolve(__dirname, '..'));
        check('DEXBOT_CLAW_DATA_DIR overrides claw data root',
            claw.DATA_DIR === dataOverride,
            `expected ${dataOverride}, got ${claw.DATA_DIR}`);
        check('positions derive from overridden claw data root',
            claw.POSITIONS_FILE === path.join(dataOverride, 'positions.json'));
    } finally {
        cfg.DEXBOT_CLAW_DATA_DIR = saved;
    }
}

// ── Summary ────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n✓ ${passed}/${total} paths tests passed`);
