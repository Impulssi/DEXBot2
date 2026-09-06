// Executes the shipped shell scripts (clear-*/reset-settings) against fake
// layouts and asserts the directories they resolve/clear. Guards against drift
// between modules/paths.ts and scripts/lib/dexbot-paths.sh.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

console.log('Running shell script path tests');

// Compiled tests live in dist/tests; the shipped scripts stay at the repo
// root. Locate the checkout by walking up until package.json + scripts land
// in the same directory.
function findRepoRoot(startDir: string): string {
    let dir = path.resolve(startDir);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json'))
            && fs.existsSync(path.join(dir, 'scripts', 'clear-all.sh'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`repo root with scripts/ not found above ${startDir}`);
        dir = parent;
    }
}

const REPO_ROOT = findRepoRoot(__dirname);
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const SHIPPED = ['clear-all.sh', 'clear-logs.sh', 'clear-orders.sh', 'clear-market-adapter.sh', 'create-bot-symlinks.sh', 'reset-settings.sh'];
const NEUTRAL_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-shell-neutral-'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-test-shell-'));

let passed = 0;
let total = 0;

function check(label: string, ok: boolean, detail?: string) {
    total++;
    if (ok) { passed++; console.log(`  ✓ ${label}`); }
    else console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

interface RunOpts { env?: Record<string, string | undefined>; cwd?: string; input?: string; noHome?: boolean; }

// Child env: scrub the host's DEXBOT_* overrides and HOME so tests are hermetic
// regardless of the developer's shell rc / migration state. When the caller
// does not provide HOME, default it to an empty temp dir (NOT the real passwd
// home, which would make resolution machine-dependent). Pass noHome to exercise
// the HOME-unset passwd fallback via a PATH-shimmed getent.
const HOME_DEFAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-shell-home-'));
const SCRUBBED_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'DEXBOT_PROFILE_ROOT', 'DEXBOT2_ROOT', 'DEXBOT_MARKET_ADAPTER_DATA_DIR', 'DEXBOT_MARKET_ADAPTER_STATE_DIR', 'DEXBOT_CLAW_DATA_DIR'];

function childEnv(extra: Record<string, string | undefined> = {}, noHome = false): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of SCRUBBED_ENV_KEYS) delete env[k];
    Object.assign(env, extra);
    if (noHome) delete env.HOME;
    else if (env.HOME === undefined) env.HOME = HOME_DEFAULT;
    return env;
}

function runScriptCaptured(scriptPath: string, opts: RunOpts = {}): { stdout: string; stderr: string; status: number } {
    const res = spawnSync('bash', [scriptPath], {
        env: childEnv(opts.env, opts.noHome),
        cwd: opts.cwd || NEUTRAL_CWD,
        input: opts.input,
        encoding: 'utf8',
    });
    return { stdout: stripAnsi(res.stdout || ''), stderr: stripAnsi(res.stderr || ''), status: res.status ?? -1 };
}

function runScript(scriptPath: string, opts: RunOpts = {}): string {
    const r = runScriptCaptured(scriptPath, opts);
    assert.strictEqual(r.status, 0, `script exited ${r.status}: ${r.stderr || r.stdout}`);
    return r.stdout;
}

function grab(lines: string[], label: string): string {
    const line = lines.find((l) => l.includes(label));
    assert.ok(line, `output missing "${label}"`);
    const m = line.match(/:[\s]*(.+)$/);
    assert.ok(m, `cannot parse "${line}"`);
    return m[1].trim();
}

function copyScripts(destScriptsDir: string): void {
    fs.mkdirSync(path.join(destScriptsDir, 'lib'), { recursive: true });
    for (const name of SHIPPED) {
        fs.copyFileSync(path.join(SCRIPTS_DIR, name), path.join(destScriptsDir, name));
    }
    fs.copyFileSync(path.join(SCRIPTS_DIR, 'lib', 'dexbot-paths.sh'), path.join(destScriptsDir, 'lib', 'dexbot-paths.sh'));
}

// ── 1) Source checkout layout (fake root with market_adapter/, profiles) ─
{
    const sourceRoot = path.join(tmpRoot, 'source-root');
    copyScripts(path.join(sourceRoot, 'scripts'));
    fs.mkdirSync(path.join(sourceRoot, 'market_adapter'), { recursive: true });
    // Populated profiles dir → legacy source checkout keeps the repo layout
    // (even with HOME unset, matching the TS passwd-home resolution).
    fs.mkdirSync(path.join(sourceRoot, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'profiles', 'bots.json'), '{}');

    const out = runScript(path.join(sourceRoot, 'scripts', 'clear-logs.sh'));
    check('source clear-logs → <root>/profiles/logs',
        grab(out.split('\n'), 'Logs Directory') === path.join(sourceRoot, 'profiles', 'logs'));
    const out2 = runScript(path.join(sourceRoot, 'scripts', 'clear-orders.sh'));
    check('source clear-orders → <root>/profiles/orders',
        grab(out2.split('\n'), 'Orders Directory') === path.join(sourceRoot, 'profiles', 'orders'));
    const out3 = runScript(path.join(sourceRoot, 'scripts', 'clear-market-adapter.sh'));
    const lines3 = out3.split('\n');
    check('source clear-market-adapter → <root>/market_adapter/data',
        grab(lines3, 'Data directory') === path.join(sourceRoot, 'market_adapter', 'data'));
    check('source clear-market-adapter → <root>/market_adapter/state',
        grab(lines3, 'State directory') === path.join(sourceRoot, 'market_adapter', 'state'));
    const out4 = runScript(path.join(sourceRoot, 'scripts', 'clear-all.sh'));
    const lines4 = out4.split('\n');
    check('source clear-all → <root>/profiles/orders',
        grab(lines4, 'Orders directory') === path.join(sourceRoot, 'profiles', 'orders'));
    check('source clear-all → <root>/profiles/logs',
        grab(lines4, 'Logs directory') === path.join(sourceRoot, 'profiles', 'logs'));
    check('source clear-all → <root>/market_adapter/data',
        grab(lines4, 'Market adapter data directory') === path.join(sourceRoot, 'market_adapter', 'data'));
    check('source clear-all → <root>/market_adapter/state',
        grab(lines4, 'Market adapter state directory') === path.join(sourceRoot, 'market_adapter', 'state'));
    check('source clear-all → <root>/claw/data',
        grab(lines4, 'Claw data directory') === path.join(sourceRoot, 'claw', 'data'));
    const out5 = runScript(path.join(sourceRoot, 'scripts', 'reset-settings.sh'));
    check('source reset-settings → <root>/profiles/general.settings.json',
        grab(out5.split('\n'), 'General settings') === path.join(sourceRoot, 'profiles', 'general.settings.json'));
}

// ── 2) Global npm package layout → home-based defaults ─────────────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'npm-home-'));
    const npmRoot = path.join(fakeHome, 'node_modules', 'dexbot');
    copyScripts(path.join(npmRoot, 'scripts'));
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    const env = { HOME: fakeHome };

    const out = runScript(path.join(npmRoot, 'scripts', 'clear-logs.sh'), { env });
    check('npm clear-logs → ~/.config/dexbot2/profiles/logs',
        grab(out.split('\n'), 'Logs Directory') === path.join(homeProfiles, 'logs'));
    const out2 = runScript(path.join(npmRoot, 'scripts', 'clear-orders.sh'), { env });
    check('npm clear-orders → ~/.config/dexbot2/profiles/orders',
        grab(out2.split('\n'), 'Orders Directory') === path.join(homeProfiles, 'orders'));
    const out3 = runScript(path.join(npmRoot, 'scripts', 'clear-market-adapter.sh'), { env });
    const lines3 = out3.split('\n');
    check('npm clear-market-adapter → <profiles>/market_adapter/data',
        grab(lines3, 'Data directory') === path.join(homeProfiles, 'market_adapter', 'data'));
    check('npm clear-market-adapter → <profiles>/market_adapter/state',
        grab(lines3, 'State directory') === path.join(homeProfiles, 'market_adapter', 'state'));
    const out4 = runScript(path.join(npmRoot, 'scripts', 'clear-all.sh'), { env });
    const lines4 = out4.split('\n');
    check('npm clear-all → <profiles>/orders',
        grab(lines4, 'Orders directory') === path.join(homeProfiles, 'orders'));
    check('npm clear-all → <profiles>/claw/data',
        grab(lines4, 'Claw data directory') === path.join(homeProfiles, 'claw', 'data'));
    const out5 = runScript(path.join(npmRoot, 'scripts', 'reset-settings.sh'), { env });
    check('npm reset-settings → <profiles>/general.settings.json',
        grab(out5.split('\n'), 'General settings') === path.join(homeProfiles, 'general.settings.json'));
}

// ── 3) Env var overrides win over every layout ─────────────────────────
{
    const envRoot = path.join(tmpRoot, 'env-root');
    copyScripts(path.join(envRoot, 'scripts'));
    fs.mkdirSync(path.join(envRoot, 'market_adapter'), { recursive: true });
    const customProfile = path.join(tmpRoot, 'custom-profile');
    const customData = path.join(tmpRoot, 'custom-ma-data');
    const customState = path.join(tmpRoot, 'custom-ma-state');
    const customClaw = path.join(tmpRoot, 'custom-claw');

    const out = runScript(path.join(envRoot, 'scripts', 'clear-logs.sh'), {
        env: { DEXBOT_PROFILE_ROOT: customProfile },
    });
    check('DEXBOT_PROFILE_ROOT overrides clear-logs',
        grab(out.split('\n'), 'Logs Directory') === path.join(customProfile, 'logs'));

    const out2 = runScript(path.join(envRoot, 'scripts', 'clear-market-adapter.sh'), {
        env: { DEXBOT_MARKET_ADAPTER_DATA_DIR: customData, DEXBOT_MARKET_ADAPTER_STATE_DIR: customState },
    });
    const lines2 = out2.split('\n');
    check('DEXBOT_MARKET_ADAPTER_DATA_DIR overrides data',
        grab(lines2, 'Data directory') === customData);
    check('DEXBOT_MARKET_ADAPTER_STATE_DIR overrides state',
        grab(lines2, 'State directory') === customState);

    const out3 = runScript(path.join(envRoot, 'scripts', 'clear-all.sh'), {
        env: { DEXBOT_CLAW_DATA_DIR: customClaw },
    });
    check('DEXBOT_CLAW_DATA_DIR overrides clear-all claw',
        grab(out3.split('\n'), 'Claw data directory') === customClaw);

    const out4 = runScript(path.join(envRoot, 'scripts', 'clear-logs.sh'), {
        env: { DEXBOT2_ROOT: path.join(tmpRoot, 'legacy-root') },
    });
    check('DEXBOT2_ROOT appends /profiles',
        grab(out4.split('\n'), 'Logs Directory') === path.join(tmpRoot, 'legacy-root', 'profiles', 'logs'));
}

// ── 4) cwd fallback mirrors paths.ts:43-50 ─────────────────────────────
// HOME is defaulted to HOME_DEFAULT, so the cwd fallback warns (stderr) with
// the same text/condition as modules/paths.ts:109 — parity is asserted, not
// just the resolved directory.
{
    const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'cwdfb-home-')));
    const sourceRoot = path.join(fakeHome, 'clone');
    copyScripts(path.join(sourceRoot, 'scripts'));
    const runCwd = path.join(fakeHome, 'workdir');
    fs.mkdirSync(path.join(runCwd, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(runCwd, 'profiles', 'bots.json'), '{}');
    const r = runScriptCaptured(path.join(sourceRoot, 'scripts', 'clear-orders.sh'), { cwd: runCwd });
    check('cwd fallback → <cwd>/profiles/orders when default has no bots.json',
        grab(r.stdout.split('\n'), 'Orders Directory') === path.join(runCwd, 'profiles', 'orders'));
    const wantWarning = `[paths] No home config at ${path.join(HOME_DEFAULT, '.config', 'dexbot2', 'profiles')}; falling back to profiles in the current directory: ${runCwd}/profiles (set DEXBOT_PROFILE_ROOT to override)`;
    check('cwd fallback warns with TS-parity text (paths.ts:109)',
        r.stderr.trim() === wantWarning, `got: ${r.stderr.trim()}`);
}

// ── 4a) No cwd-fallback warning in source or npm layouts ──────────────
// The warning must only fire for a genuine cwd fallback — never for the
// expected repo (silent) or home/npm layouts.
{
    const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'quiet-home-')));
    const sourceRoot = path.join(fakeHome, 'clone');
    copyScripts(path.join(sourceRoot, 'scripts'));
    fs.mkdirSync(path.join(sourceRoot, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'profiles', 'bots.json'), '{}');
    const r = runScriptCaptured(path.join(sourceRoot, 'scripts', 'clear-orders.sh'), { cwd: sourceRoot });
    check('source layout resolves repo profiles silently',
        grab(r.stdout.split('\n'), 'Orders Directory') === path.join(sourceRoot, 'profiles', 'orders'));
    check('no cwd-fallback warning for source layout',
        !r.stderr.includes('falling back to profiles'), `stderr: ${r.stderr}`);
}

// ── 4b) Keys-only legacy checkout kept (not treated as "fresh") ────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'keysonly-home-'));
    const sourceRoot = path.join(fakeHome, 'clone');
    copyScripts(path.join(sourceRoot, 'scripts'));
    fs.mkdirSync(path.join(sourceRoot, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'profiles', 'keys.json'), '{}');
    const env = { HOME: fakeHome };
    const out = runScript(path.join(sourceRoot, 'scripts', 'clear-orders.sh'), { env });
    check('keys-only legacy checkout keeps repo profiles/orders',
        grab(out.split('\n'), 'Orders Directory') === path.join(sourceRoot, 'profiles', 'orders'));
}

// ── 5) Functional: clear-all deletes claw + orders + logs + MA files ──
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'func-home-'));
    const npmRoot = path.join(fakeHome, 'node_modules', 'dexbot');
    copyScripts(path.join(npmRoot, 'scripts'));
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    const env = { HOME: fakeHome };

    const ordersDir = path.join(homeProfiles, 'orders');
    const logsDir = path.join(homeProfiles, 'logs');
    const maDataDir = path.join(homeProfiles, 'market_adapter', 'data');
    const maStateDir = path.join(homeProfiles, 'market_adapter', 'state');
    const clawDir = path.join(homeProfiles, 'claw', 'data');
    fs.mkdirSync(ordersDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(maDataDir, { recursive: true });
    fs.mkdirSync(maStateDir, { recursive: true });
    fs.mkdirSync(path.join(clawDir, 'memu'), { recursive: true });
    fs.writeFileSync(path.join(ordersDir, 'AAA-BBB.orders.json'), '{}');
    fs.writeFileSync(path.join(logsDir, 'AAA-BBB.log'), 'x');
    fs.writeFileSync(path.join(maDataDir, 'candles.json'), '{}');
    fs.writeFileSync(path.join(maStateDir, 'market_adapter_state.json'), '{}');
    fs.writeFileSync(path.join(clawDir, 'positions.json'), '{}');
    fs.writeFileSync(path.join(clawDir, 'watcher-health.json'), '{}');
    fs.writeFileSync(path.join(clawDir, 'memu', 'notes.json'), '{}');

    const out = runScript(path.join(npmRoot, 'scripts', 'clear-all.sh'), { env, input: 'y\n' });
    check('clear-all reports claw files deleted',
        /claw: [0-9]+/.test(out) && out.includes('All files cleared!'), out.split('\n').slice(-6).join(' '));
    check('clear-all removed orders', !fs.existsSync(path.join(ordersDir, 'AAA-BBB.orders.json')));
    check('clear-all removed logs', !fs.existsSync(path.join(logsDir, 'AAA-BBB.log')));
    check('clear-all removed MA data', !fs.existsSync(path.join(maDataDir, 'candles.json')));
    check('clear-all removed MA state', !fs.existsSync(path.join(maStateDir, 'market_adapter_state.json')));
    check('clear-all removed claw positions', !fs.existsSync(path.join(clawDir, 'positions.json')));
    check('clear-all removed claw watcher health', !fs.existsSync(path.join(clawDir, 'watcher-health.json')));
    check('clear-all removed claw memu', !fs.existsSync(path.join(clawDir, 'memu', 'notes.json')));

    const remainingFiles = fs.readdirSync(homeProfiles, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name);
    check('clear-all left no files under profiles',
        remainingFiles.length === 0, remainingFiles.join(','));
}

// ── 6) Functional: create-bot-symlinks.sh uses the lib (npm layout) ────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'symlinks-home-'));
    const npmRoot = path.join(fakeHome, 'node_modules', 'dexbot');
    copyScripts(path.join(npmRoot, 'scripts'));
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    fs.mkdirSync(homeProfiles, { recursive: true });
    fs.writeFileSync(path.join(homeProfiles, 'bots.json'), JSON.stringify({ bots: [{ name: 'AAA-BBB' }] }));
    fs.writeFileSync(path.join(homeProfiles, 'ecosystem.config.cjs'), '');

    const env = { HOME: fakeHome };
    const res = spawnSync('bash', [path.join(npmRoot, 'scripts', 'create-bot-symlinks.sh')], {
        env: childEnv(env),
        cwd: NEUTRAL_CWD,
        encoding: 'utf8',
    });
    check('create-bot-symlinks runs from npm layout', res.status === 0, `${res.status}: ${res.stderr || res.stdout}`);
    const link = path.join(homeProfiles, 'AAA-BBB.config.cjs');
    check('create-bot-symlinks targets home profiles',
        fs.existsSync(link) && fs.readlinkSync(link) === path.join(homeProfiles, 'ecosystem.config.cjs'));
    check('create-bot-symlinks does not write into package dir',
        !fs.existsSync(path.join(npmRoot, 'profiles')));
}

// ── 7) Fresh source checkout (no bots.json) → all state under home ─────
// A source checkout that has not configured bots yet must not split state:
// profiles AND market-adapter/claw all follow ~/.config/dexbot2/profiles,
// even though the repo ships a market_adapter/ dir.
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'fresh-src-home-'));
    const sourceRoot = path.join(fakeHome, 'clone');
    copyScripts(path.join(sourceRoot, 'scripts'));
    fs.mkdirSync(path.join(sourceRoot, 'market_adapter'), { recursive: true });
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    const env = { HOME: fakeHome };

    const out = runScript(path.join(sourceRoot, 'scripts', 'clear-all.sh'), { env });
    const lines = out.split('\n');
    check('fresh source → <home>/profiles/orders',
        grab(lines, 'Orders directory') === path.join(homeProfiles, 'orders'));
    check('fresh source → <home>/profiles/logs',
        grab(lines, 'Logs directory') === path.join(homeProfiles, 'logs'));
    check('fresh source → <home>/profiles/market_adapter/data',
        grab(lines, 'Market adapter data directory') === path.join(homeProfiles, 'market_adapter', 'data'));
    check('fresh source → <home>/profiles/market_adapter/state',
        grab(lines, 'Market adapter state directory') === path.join(homeProfiles, 'market_adapter', 'state'));
    check('fresh source → <home>/profiles/claw/data',
        grab(lines, 'Claw data directory') === path.join(homeProfiles, 'claw', 'data'));
    check('fresh source does not write into the repo',
        !fs.existsSync(path.join(sourceRoot, 'profiles')) && !fs.existsSync(path.join(sourceRoot, 'market_adapter', 'data')));
}

// ── 8) HOME unset → passwd home via getent (hermetic) ─────────────────
// Fix #3 makes a missing HOME consult the passwd entry (getent on Linux).
// Exercised hermetically by shimming PATH with a fake getent that reports a
// temp passwd home.
{
    const fakePasswdHome = fs.mkdtempSync(path.join(tmpRoot, 'passwd-home-'));
    const shimDir = path.join(tmpRoot, 'bin-shim');
    fs.mkdirSync(shimDir, { recursive: true });
    const uid = (typeof process.getuid === 'function') ? process.getuid() : 1000;
    fs.writeFileSync(path.join(shimDir, 'getent'),
        `#!/bin/sh\ncase "$1" in\n  passwd) echo "${uid}:x:1000:1000:fake:${fakePasswdHome}:/bin/sh" ;;\nesac\nexit 0\n`);
    fs.chmodSync(path.join(shimDir, 'getent'), 0o755);

    const sourceRoot = path.join(tmpRoot, 'passwd-src');
    copyScripts(path.join(sourceRoot, 'scripts'));

    const out = runScript(path.join(sourceRoot, 'scripts', 'clear-all.sh'), {
        noHome: true,
        env: { PATH: `${shimDir}:${process.env.PATH}` },
    });
    check('HOME unset → getent passwd home used for profiles',
        grab(out.split('\n'), 'Orders directory') === path.join(fakePasswdHome, '.config', 'dexbot2', 'profiles', 'orders'));
}

// ── Cleanup ────────────────────────────────────────────────────────────
fs.rmSync(HOME_DEFAULT, { recursive: true, force: true });
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.rmSync(NEUTRAL_CWD, { recursive: true, force: true });

console.log(`\n✓ ${passed}/${total} shell script path tests passed`);
