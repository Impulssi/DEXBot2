// Executes the shipped shell scripts (clear-*/reset-settings) against fake
// layouts and asserts the directories they resolve/clear. Guards against drift
// between modules/paths.ts and scripts/lib/dexbot-paths.sh.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

console.log('Running shell script path tests');

const REPO_ROOT = path.resolve(__dirname, '..');
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

interface RunOpts { env?: Record<string, string | undefined>; cwd?: string; input?: string; }

function runScript(scriptPath: string, opts: RunOpts = {}): string {
    const env = { ...process.env, ...opts.env };
    if (opts.env?.HOME === undefined) delete env.HOME;
    const res = spawnSync('bash', [scriptPath], {
        env,
        cwd: opts.cwd || NEUTRAL_CWD,
        input: opts.input,
        encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, `script exited ${res.status}: ${res.stderr || res.stdout}`);
    return stripAnsi(res.stdout);
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

// ── 1) Source checkout layout (fake root with market_adapter/, no files) ─
{
    const sourceRoot = path.join(tmpRoot, 'source-root');
    copyScripts(path.join(sourceRoot, 'scripts'));
    fs.mkdirSync(path.join(sourceRoot, 'market_adapter'), { recursive: true });

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
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'cwdfb-home-'));
    const sourceRoot = path.join(fakeHome, 'clone');
    copyScripts(path.join(sourceRoot, 'scripts'));
    const runCwd = path.join(fakeHome, 'workdir');
    fs.mkdirSync(path.join(runCwd, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(runCwd, 'profiles', 'bots.json'), '{}');
    const out = runScript(path.join(sourceRoot, 'scripts', 'clear-orders.sh'), { cwd: runCwd });
    check('cwd fallback → <cwd>/profiles/orders when default has no bots.json',
        grab(out.split('\n'), 'Orders Directory') === path.join(runCwd, 'profiles', 'orders'));
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
    fs.writeFileSync(path.join(ordersDir, 'XRP-BTS.orders.json'), '{}');
    fs.writeFileSync(path.join(logsDir, 'XRP-BTS.log'), 'x');
    fs.writeFileSync(path.join(maDataDir, 'candles.json'), '{}');
    fs.writeFileSync(path.join(maStateDir, 'market_adapter_state.json'), '{}');
    fs.writeFileSync(path.join(clawDir, 'positions.json'), '{}');
    fs.writeFileSync(path.join(clawDir, 'watcher-health.json'), '{}');
    fs.writeFileSync(path.join(clawDir, 'memu', 'notes.json'), '{}');

    const out = runScript(path.join(npmRoot, 'scripts', 'clear-all.sh'), { env, input: 'y\n' });
    check('clear-all reports claw files deleted',
        /claw: [0-9]+/.test(out) && out.includes('All files cleared!'), out.split('\n').slice(-6).join(' '));
    check('clear-all removed orders', !fs.existsSync(path.join(ordersDir, 'XRP-BTS.orders.json')));
    check('clear-all removed logs', !fs.existsSync(path.join(logsDir, 'XRP-BTS.log')));
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
    fs.writeFileSync(path.join(homeProfiles, 'bots.json'), JSON.stringify({ bots: [{ name: 'XRP-BTS' }] }));
    fs.writeFileSync(path.join(homeProfiles, 'ecosystem.config.cjs'), '');

    const env = { HOME: fakeHome };
    const res = spawnSync('bash', [path.join(npmRoot, 'scripts', 'create-bot-symlinks.sh')], {
        env: { ...process.env, ...env },
        cwd: NEUTRAL_CWD,
        encoding: 'utf8',
    });
    check('create-bot-symlinks runs from npm layout', res.status === 0, `${res.status}: ${res.stderr || res.stdout}`);
    const link = path.join(homeProfiles, 'XRP-BTS.config.js');
    check('create-bot-symlinks targets home profiles',
        fs.existsSync(link) && fs.readlinkSync(link) === path.join(homeProfiles, 'ecosystem.config.cjs'));
    check('create-bot-symlinks does not write into package dir',
        !fs.existsSync(path.join(npmRoot, 'profiles')));
}

// ── Cleanup ────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.rmSync(NEUTRAL_CWD, { recursive: true, force: true });

console.log(`\n✓ ${passed}/${total} shell script path tests passed`);
