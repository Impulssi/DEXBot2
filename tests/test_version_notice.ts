// Must be before any require() due to the config-caching trap: Config
// snapshots process.env at module-load time, so DEXBOT_SKIP_VERSION_NOTICE
// has to be set here rather than inside a test case.
process.env.DEXBOT_SKIP_VERSION_NOTICE = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running version notice tests');

const {
    compareVersions,
    detectInstallKind,
    startVersionStatusCheck,
    formatVersionStatusLine,
    printVersionStatus,
    flushVersionStatus,
    printVersionStatusWhenReady,
} = require('../modules/version_notice');
const { CLI_COLORS } = require('../modules/cli_colors');

/** Notice-only view for the latch/throttle cases; the module itself exposes
 *  only the status so no caller can render its own copy of the message. */
const noticeOf = async (options: any) => (await startVersionStatusCheck(options))?.notice ?? null;
const { Config } = require('../modules/config');

let passed = 0;
let total = 0;

function check(label: string, ok: any, detail?: any) {
    total++;
    if (ok) { passed++; console.log(`  ✓ ${label}`); }
    else console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-version-notice-'));
const cacheFile = path.join(tmpRoot, 'version_check.json');

/** Build a fetch stub that reports a fixed registry payload. */
function stubFetch(version: any, calls?: { n: number }) {
    return async () => {
        if (calls) calls.n++;
        if (version instanceof Error) throw version;
        return { ok: true, json: async () => ({ version }) };
    };
}

function readCache(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Run a callback with console.log muted — printVersionStatus is otherwise noisy. */
function quiet<T>(fn: () => T): T {
    const orig = console.log;
    (console as any).log = () => {};
    try { return fn(); } finally { (console as any).log = orig; }
}

/** Async-aware quiet(). */
async function quietAsync(fn: () => Promise<any>): Promise<void> {
    const orig = console.log;
    (console as any).log = () => {};
    try { await fn(); } finally { (console as any).log = orig; }
}

const BASE = {
    cacheFile,
    currentVersion: '1.6.7',
    intervalMs: 86_400_000,
    registryUrl: 'https://registry.invalid/dexbot/latest',
    installKind: 'npm-global',
    now: 1_000_000,
    force: true,
};

async function main() {

// The env var above is asserted in section 8; every other case needs the
// module live, so flip the already-snapshotted Config flag.
Config.DEXBOT_SKIP_VERSION_NOTICE = false;

// ── 1) compareVersions ordering ───────────────────────────────────────
{
    check('equal versions compare to 0', compareVersions('1.6.7', '1.6.7') === 0);
    check('older patch sorts below newer', compareVersions('1.6.7', '1.6.10') < 0);
    check('1.6.10 sorts above 1.6.7', compareVersions('1.6.10', '1.6.7') > 0);
    check('minor ordering', compareVersions('1.6.7', '1.7.0') < 0);
    check('major ordering', compareVersions('2.0.0', '1.99.99') > 0);
    check('prerelease suffix is ignored', compareVersions('1.6.7-beta.1', '1.6.7') === 0);
    check('non-numeric segment degrades to 0, not NaN', compareVersions('1.x.7', '1.0.7') === 0);
    check('missing segments pad with 0', compareVersions('1.6', '1.6.0') === 0);
}

// ── 2) Install-kind detection without spawning ───────────────────────
{
    const repoRoot = path.join(tmpRoot, 'fake-repo', 'node_modules', 'dexbot');
    check('npm package dir is detected as npm-global',
        detectInstallKind(repoRoot) === 'npm-global', detectInstallKind(repoRoot));

    const gitDir = path.join(tmpRoot, 'fake-git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, '.git'), '', { mode: 0o600 });
    check('a directory holding .git is detected as git',
        detectInstallKind(gitDir) === 'git', detectInstallKind(gitDir));

    const bareDir = path.join(tmpRoot, 'fake-bare');
    fs.mkdirSync(bareDir, { recursive: true });
    check('a plain directory is detected as other',
        detectInstallKind(bareDir) === 'other', detectInstallKind(bareDir));
}

// ── 3) A newer version produces exactly one notice ───────────────────
{
    const calls = { n: 0 };
    const status = await startVersionStatusCheck({ ...BASE, fetchImpl: stubFetch('1.7.0', calls) });
    const notice = status?.notice ?? null;
    check('newer version yields a notice', !!notice);
    check('the state is update-available', status && status.state === 'update-available', JSON.stringify(status));
    check('notice reports both versions',
        notice && notice.currentVersion === '1.6.7' && notice.latestVersion === '1.7.0',
        JSON.stringify(notice));
    check('exactly one registry request was made', calls.n === 1, `n=${calls.n}`);

    const cached = readCache(cacheFile);
    check('cache records the probe time', cached && cached.lastCheckMs === BASE.now, JSON.stringify(cached));
    check('cache records the latest version', cached && cached.latestVersion === '1.7.0');
    check('a probe alone does NOT latch the announced version',
        cached && cached.notifiedVersion === null, JSON.stringify(cached));

    // What the operator actually sees — the wording lives in one renderer.
    const lines: string[] = [];
    const origLog = console.log;
    (console as any).log = (msg: any) => { lines.push(String(msg)); };
    try { printVersionStatus(status, { indent: '', surround: false }); } finally { (console as any).log = origLog; }
    check('the output names the latest version', (lines[0] || '').includes('v1.7.0'), lines[0]);
    check('the output names the installed version', (lines[0] || '').includes('v1.6.7'), lines[0]);
    check('the output points at `dexbot update`', (lines[1] || '').includes('dexbot update'), lines[1]);

    quiet(() => printVersionStatus(status));
    check('printing the notice latches the announced version',
        readCache(cacheFile).notifiedVersion === '1.7.0', JSON.stringify(readCache(cacheFile)));
    quiet(() => printVersionStatus(null));
    check('printVersionStatus(null) is a no-op', readCache(cacheFile).notifiedVersion === '1.7.0');
}

// ── 4) The same version is never announced twice ─────────────────────
{
    const calls = { n: 0 };
    const notice = await noticeOf({ ...BASE, force: false, now: BASE.now + 43_200_000, fetchImpl: stubFetch('1.7.0', calls) });
    check('re-check inside the 24h interval makes no request', calls.n === 0, `n=${calls.n}`);
    check('re-check inside the interval is silent', notice === null, JSON.stringify(notice));
}
{
    // Same version, but the throttle window has expired: the request runs
    // again yet the notice stays latched.
    const calls = { n: 0 };
    const notice = await noticeOf({ ...BASE, force: false, now: BASE.now + 200_000_000, fetchImpl: stubFetch('1.7.0', calls) });
    check('expired window re-probes the registry', calls.n === 1, `n=${calls.n}`);
    check('an already-announced version is not repeated', notice === null, JSON.stringify(notice));
}

// ── 5) A newly published version resets the latch ────────────────────
{
    const status = await startVersionStatusCheck({ ...BASE, force: true, now: BASE.now + 300_000_000, fetchImpl: stubFetch('1.8.0') });
    check('a new published version is announced again', status?.notice?.latestVersion === '1.8.0', JSON.stringify(status));
    quiet(() => printVersionStatus(status));
    check('cache latch advances to the new version', readCache(cacheFile).notifiedVersion === '1.8.0');
}

// ── 5b) The latch never regresses ────────────────────────────────────
{
    // A registry that briefly serves an older `latest` (dist-tag rollback)
    // must not lower the latch and let an already-announced version reappear.
    quiet(() => printVersionStatus({
        currentVersion: '1.6.7', latestVersion: '1.7.0', installKind: 'npm-global', state: 'update-available',
        cacheFile, notice: { currentVersion: '1.6.7', latestVersion: '1.7.0', installKind: 'npm-global', cacheFile },
    }));
    check('an older notice does not regress the latch', readCache(cacheFile).notifiedVersion === '1.8.0');
}

// ── 5c) An unprinted notice is re-offered, not silently consumed ──────
{
    const unprintedCache = path.join(tmpRoot, 'version_check_unprinted.json');
    const first = await noticeOf({
        ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', fetchImpl: stubFetch('1.9.0'),
    });
    check('an unprinted notice is produced', first && first.latestVersion === '1.9.0', JSON.stringify(first));
    check('an unprinted notice is not latched', readCache(unprintedCache).notifiedVersion === null);

    const second = await noticeOf({
        ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', force: true, fetchImpl: stubFetch('1.9.0'),
    });
    check('the same notice is offered again on the next run', second && second.latestVersion === '1.9.0', JSON.stringify(second));

    // The centralized flush wrapper must print and latch exactly like the
    // other print paths.
    await quietAsync(() => flushVersionStatus(startVersionStatusCheck({ ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', force: true, fetchImpl: stubFetch('1.9.0') })));
    check('flushVersionStatus latches the displayed version', readCache(unprintedCache).notifiedVersion === '1.9.0');
}

// ── 5d) The non-blocking print never delays the caller ───────────────
{
    const whenReadyCache = path.join(tmpRoot, 'version_check_whenready.json');
    let release: any;
    const pending = new Promise<any>((resolve) => { release = resolve; });
    const orig = console.log;
    (console as any).log = () => {};
    try {
        const t0 = Date.now();
        printVersionStatusWhenReady(pending);
        check('printVersionStatusWhenReady returns without awaiting', Date.now() - t0 < 100, `${Date.now() - t0}ms`);
        check('nothing is latched before the probe settles',
            readCache(whenReadyCache) === null);

        const readyStatus = await startVersionStatusCheck({
            ...BASE, cacheFile: whenReadyCache, currentVersion: '1.0.0', fetchImpl: stubFetch('1.2.0'),
        });
        release(readyStatus);
        await new Promise((r) => setTimeout(r, 0));
        check('the notice is latched once the probe settles',
            readCache(whenReadyCache).notifiedVersion === '1.2.0');
    } finally {
        (console as any).log = orig;
    }
}

// ── 6) Up-to-date and ahead-of-registry installs stay silent ─────────
{
    const notice = await noticeOf({
        ...BASE, currentVersion: '1.8.0', force: true, now: 400_000_000, fetchImpl: stubFetch('1.8.0'),
    });
    check('installed version equal to latest is silent', notice === null);
}
{
    const notice = await noticeOf({
        ...BASE, currentVersion: '2.0.0', force: true, now: 500_000_000, fetchImpl: stubFetch('1.8.0'),
    });
    check('installed version ahead of latest is silent', notice === null);
}

// ── 7) Network failures are silent but still throttle ────────────────
{
    const freshCache = path.join(tmpRoot, 'version_check_offline.json');
    const calls = { n: 0 };
    const notice = await noticeOf({
        ...BASE, cacheFile: freshCache, now: 600_000_000, fetchImpl: stubFetch(new Error('ENOTFOUND'), calls),
    });
    check('a network failure yields no notice', notice === null);
    const cached = readCache(freshCache);
    check('a network failure still records the probe so it backs off',
        cached && cached.lastCheckMs === 600_000_000, JSON.stringify(cached));
    check('a failed probe is not latched as announced', cached && cached.notifiedVersion === null);

    const retryCalls = { n: 0 };
    await noticeOf({
        ...BASE, cacheFile: freshCache, force: false, now: 600_000_100, fetchImpl: stubFetch(new Error('ENOTFOUND'), retryCalls),
    });
    check('an offline node does not re-probe on the next start', retryCalls.n === 0, `n=${retryCalls.n}`);
}
{
    const httpFailCache = path.join(tmpRoot, 'version_check_http.json');
    const notice = await noticeOf({
        ...BASE, cacheFile: httpFailCache, now: 700_000_000,
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    check('a non-2xx registry response yields no notice', notice === null);
}
{
    const badBodyCache = path.join(tmpRoot, 'version_check_body.json');
    const notice = await noticeOf({
        ...BASE, cacheFile: badBodyCache, now: 800_000_000,
        fetchImpl: async () => ({ ok: true, json: async () => ({ notAVersion: 1 }) }),
    });
    check('a malformed registry body yields no notice', notice === null);
}
{
    // A hung registry must be cut off by the option override, not the 2s
    // default — this is the path `dexbot status` relies on to stay responsive.
    const timeoutCache = path.join(tmpRoot, 'version_check_timeout.json');
    const notice = await noticeOf({
        ...BASE, cacheFile: timeoutCache, now: 850_000_000, timeoutMs: 20,
        fetchImpl: (_url: any, init: any) => new Promise((_resolve: any, reject: any) => {
            if (init?.signal?.aborted) return reject(new Error('aborted'));
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    check('a hung registry request is aborted at the timeout override', notice === null);
}
{
    // The hard timeout must not depend on AbortController existing or on the
    // fetch honoring the abort signal: a never-settling fetch still resolves.
    const noAbortCache = path.join(tmpRoot, 'version_check_noabort.json');
    const savedAbort = (global as any).AbortController;
    (global as any).AbortController = undefined;
    try {
        const notice = await noticeOf({
            ...BASE, cacheFile: noAbortCache, now: 875_000_000, timeoutMs: 20,
            fetchImpl: () => new Promise(() => {}), // never settles, ignores signal
        });
        check('a never-settling fetch is bounded even without AbortController', notice === null);
    } finally {
        (global as any).AbortController = savedAbort;
    }
}

// ── 8) Kill switches ─────────────────────────────────────────────────
{
    const calls = { n: 0 };
    const offCache = path.join(tmpRoot, 'version_check_off.json');
    const notice = await noticeOf({ ...BASE, cacheFile: offCache, enabled: false, fetchImpl: stubFetch('9.9.9', calls) });
    check('the notice opt-out is silent', notice === null);
    check('the notice opt-out makes no request', calls.n === 0, `n=${calls.n}`);
    check('the notice opt-out writes no cache file', !fs.existsSync(offCache));
}
{
    // The env var is set at line 1 of this file, before the config snapshot,
    // so re-asserting the flag above proves the ENV-driven kill switch, not a
    // hand-set Config field.
    const calls = { n: 0 };
    const skipCache = path.join(tmpRoot, 'version_check_skip.json');
    Config.DEXBOT_SKIP_VERSION_NOTICE = true;
    try {
        const notice = await noticeOf({ ...BASE, cacheFile: skipCache, fetchImpl: stubFetch('9.9.9', calls) });
        check('DEXBOT_SKIP_VERSION_NOTICE=1 is silent', notice === null);
        check('DEXBOT_SKIP_VERSION_NOTICE=1 makes no request', calls.n === 0, `n=${calls.n}`);
    } finally {
        Config.DEXBOT_SKIP_VERSION_NOTICE = false;
    }
}
{
    // A missing REGISTRY_URL must not burn a throttle window: the notice has
    // to appear as soon as an operator configures it.
    const noUrlCache = path.join(tmpRoot, 'version_check_nourl.json');
    const notice = await noticeOf({ ...BASE, cacheFile: noUrlCache, registryUrl: '', fetchImpl: stubFetch('9.9.9') });
    check('an empty REGISTRY_URL is silent', notice === null);
    check('an empty REGISTRY_URL writes no cache file', !fs.existsSync(noUrlCache));
}
{
    // A current version that cannot be read must not produce a bogus notice.
    const noVerCache = path.join(tmpRoot, 'version_check_nover.json');
    const notice = await noticeOf({ ...BASE, cacheFile: noVerCache, currentVersion: '', fetchImpl: stubFetch('9.9.9') });
    check('an unreadable current version is silent', notice === null);
}

// ── 9) Cache corruption is survivable ────────────────────────────────
{
    const corruptCache = path.join(tmpRoot, 'version_check_corrupt.json');
    fs.writeFileSync(corruptCache, '{not json', { mode: 0o600 });
    const notice = await noticeOf({ ...BASE, cacheFile: corruptCache, fetchImpl: stubFetch('1.9.0') });
    check('a corrupt cache does not break the check', notice && notice.latestVersion === '1.9.0', JSON.stringify(notice));
}
{
    const wrongVersionCache = path.join(tmpRoot, 'version_check_v0.json');
    fs.writeFileSync(wrongVersionCache, JSON.stringify({ version: 0, lastCheckMs: 9e15 }), { mode: 0o600 });
    const notice = await noticeOf({ ...BASE, cacheFile: wrongVersionCache, fetchImpl: stubFetch('1.9.0') });
    check('a cache from a foreign schema version is ignored', notice && notice.latestVersion === '1.9.0');
}
{
    const badTypeCache = path.join(tmpRoot, 'version_check_badtype.json');
    fs.writeFileSync(badTypeCache, JSON.stringify({
        version: 1, lastCheckMs: 9e15, latestVersion: { nope: true }, notifiedVersion: null,
    }), { mode: 0o600 });
    const notice = await noticeOf({ ...BASE, cacheFile: badTypeCache, fetchImpl: stubFetch('1.9.0') });
    check('a cache with a non-string version field is ignored', notice && notice.latestVersion === '1.9.0');
}

// ── 10) Hint text adapts to the install layout ───────────────────────
{
    for (const [installKind, expected] of [['git', 'pull it'], ['npm-global', 'install it'], ['other', 'install it']] as const) {
        const kindCache = path.join(tmpRoot, `version_check_hint_${installKind}.json`);
        const status = await startVersionStatusCheck({
            ...BASE, cacheFile: kindCache, installKind, currentVersion: '1.0.0',
            now: 900_000_000, fetchImpl: stubFetch('1.1.0'),
        });
        const lines: string[] = [];
        const origLog = console.log;
        (console as any).log = (msg: any) => { lines.push(String(msg)); };
        try { printVersionStatus(status, { indent: '', surround: false }); } finally { (console as any).log = origLog; }
        check(`a ${installKind} install gets the "${expected}" hint`,
            (lines[1] || '').includes(expected), JSON.stringify(lines));
    }
}

// ── 11) Status states drive colour and wording (dexbot stat + start) ──
{
    const upToDate = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_current.json'), now: 1_000_000_000,
        fetchImpl: stubFetch('1.6.7'),
    });
    check('equal versions read as up-to-date', upToDate && upToDate.state === 'up-to-date', JSON.stringify(upToDate));
    check('up-to-date yields no notice', upToDate && upToDate.notice === null);
    const currentLine = formatVersionStatusLine(upToDate!);
    check('up-to-date line is green and says so',
        currentLine.includes(CLI_COLORS.brightGreen) && currentLine.includes('Your version is up to date'), currentLine);
    check('up-to-date line names the installed version', currentLine.includes('DEXBot2 v1.6.7'), currentLine);
    check('up-to-date line is not orange', !currentLine.includes(CLI_COLORS.orange), currentLine);
}
{
    const ahead = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_ahead.json'), now: 1_000_000_000,
        currentVersion: '2.0.0', fetchImpl: stubFetch('1.6.7'),
    });
    check('an install ahead of latest is not flagged as outdated',
        ahead && ahead.state === 'up-to-date', JSON.stringify(ahead));
}
{
    const available = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_new.json'), now: 1_000_000_000,
        currentVersion: '1.6.7', fetchImpl: stubFetch('1.7.0'),
    });
    check('a newer release reads as update-available', available && available.state === 'update-available');
    const newLine = formatVersionStatusLine(available!);
    check('update-available line is orange',
        newLine.includes(CLI_COLORS.orange) && newLine.includes('A new version is available'), newLine);
    check('update-available line is not green', !newLine.includes(CLI_COLORS.brightGreen), newLine);
}
{
    const calls = { n: 0 };
    const offline = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_offline.json'), now: 1_000_000_000,
        fetchImpl: stubFetch(new Error('ENOTFOUND'), calls),
    });
    check('a failed probe reads as unknown, never as up-to-date',
        offline && offline.state === 'unknown', JSON.stringify(offline));
    check('an unknown status still names the installed version',
        (offline && formatVersionStatusLine(offline).includes('DEXBot2 v1.6.7')) || false);
    check('an unknown status carries no notice', offline && offline.notice === null);
}
{
    // A throttled run spends no request but still answers "am I current?" from
    // the cached observation — that is what `dexbot stat` renders.
    const cache = path.join(tmpRoot, 'status_throttled.json');
    await startVersionStatusCheck({ ...BASE, cacheFile: cache, now: 1_000_000_000, fetchImpl: stubFetch('1.7.0') });
    const throttledCalls = { n: 0 };
    const throttled = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: false, now: 1_000_000_000 + 60_000, fetchImpl: stubFetch('1.7.0', throttledCalls),
    });
    check('a throttled run makes no request', throttledCalls.n === 0, `n=${throttledCalls.n}`);
    check('a throttled run still reports the update state from the cache',
        throttled && throttled.state === 'update-available', JSON.stringify(throttled));
}
{
    // The print path is the single place a hint is shown and latched.
    const cache = path.join(tmpRoot, 'status_print.json');
    const status = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, now: 1_000_000_000, currentVersion: '1.0.0', fetchImpl: stubFetch('1.5.0'),
    });
    const lines: string[] = [];
    const orig = console.log;
    (console as any).log = (msg: any) => { lines.push(String(msg)); };
    try { printVersionStatus(status, { indent: '', surround: false }); } finally { (console as any).log = orig; }
    check('the status line is printed', lines[0] && lines[0].includes('A new version is available'), JSON.stringify(lines));
    check('the install hint follows the status line', lines[1] && lines[1].includes('dexbot update'), JSON.stringify(lines));
    check('printing the status latches the announced version', readCache(cache).notifiedVersion === '1.5.0');

    const relatched = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, now: 1_000_000_000, force: false, currentVersion: '1.0.0', fetchImpl: stubFetch('1.5.0'),
    });
    check('an announced version is no longer offered as a notice', relatched && relatched.notice === null);
    const again: string[] = [];
    (console as any).log = (msg: any) => { again.push(String(msg)); };
    try { printVersionStatus(relatched, { indent: '', surround: false }); } finally { (console as any).log = orig; }
    check('the orange status line is still shown after the latch', again[0] && again[0].includes('A new version is available'), JSON.stringify(again));
    check('no hint is repeated once latched', again.length === 1, JSON.stringify(again));
}

// ── Summary ───────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

assert.strictEqual(passed, total, `${passed}/${total} version notice tests passed`);
console.log(`\n✓ ${passed}/${total} version notice tests passed`);
}

main().catch((err) => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
});
