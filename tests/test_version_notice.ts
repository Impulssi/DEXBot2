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
    startVersionNoticeCheck,
    printVersionNotice,
    flushVersionNotice,
    printVersionNoticeWhenReady,
} = require('../modules/version_notice');
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

/** Run a callback with console.log muted — printVersionNotice is otherwise noisy. */
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
    const notice = await startVersionNoticeCheck({ ...BASE, fetchImpl: stubFetch('1.7.0', calls) });
    check('newer version yields a notice', !!notice);
    check('notice reports both versions',
        notice && notice.currentVersion === '1.6.7' && notice.latestVersion === '1.7.0',
        JSON.stringify(notice));
    check('message names the latest version', (notice && notice.message || '').includes('v1.7.0'), notice && notice.message);
    check('message names the installed version', (notice && notice.message || '').includes('v1.6.7'), notice && notice.message);
    check('message points at `dexbot update`', (notice && notice.message || '').includes('dexbot update'), notice && notice.message);
    check('exactly one registry request was made', calls.n === 1, `n=${calls.n}`);

    const cached = readCache(cacheFile);
    check('cache records the probe time', cached && cached.lastCheckMs === BASE.now, JSON.stringify(cached));
    check('cache records the latest version', cached && cached.latestVersion === '1.7.0');
    check('a probe alone does NOT latch the announced version',
        cached && cached.notifiedVersion === null, JSON.stringify(cached));

    quiet(() => printVersionNotice(notice));
    check('printing the notice latches the announced version',
        readCache(cacheFile).notifiedVersion === '1.7.0', JSON.stringify(readCache(cacheFile)));
    quiet(() => printVersionNotice(null));
    check('printVersionNotice(null) is a no-op', readCache(cacheFile).notifiedVersion === '1.7.0');
}

// ── 4) The same version is never announced twice ─────────────────────
{
    const calls = { n: 0 };
    const notice = await startVersionNoticeCheck({ ...BASE, force: false, now: BASE.now + 43_200_000, fetchImpl: stubFetch('1.7.0', calls) });
    check('re-check inside the 24h interval makes no request', calls.n === 0, `n=${calls.n}`);
    check('re-check inside the interval is silent', notice === null, JSON.stringify(notice));
}
{
    // Same version, but the throttle window has expired: the request runs
    // again yet the notice stays latched.
    const calls = { n: 0 };
    const notice = await startVersionNoticeCheck({ ...BASE, force: false, now: BASE.now + 200_000_000, fetchImpl: stubFetch('1.7.0', calls) });
    check('expired window re-probes the registry', calls.n === 1, `n=${calls.n}`);
    check('an already-announced version is not repeated', notice === null, JSON.stringify(notice));
}

// ── 5) A newly published version resets the latch ────────────────────
{
    const notice = await startVersionNoticeCheck({ ...BASE, force: true, now: BASE.now + 300_000_000, fetchImpl: stubFetch('1.8.0') });
    check('a new published version is announced again', notice && notice.latestVersion === '1.8.0', JSON.stringify(notice));
    quiet(() => printVersionNotice(notice));
    check('cache latch advances to the new version', readCache(cacheFile).notifiedVersion === '1.8.0');
}

// ── 5b) The latch never regresses ────────────────────────────────────
{
    // A registry that briefly serves an older `latest` (dist-tag rollback)
    // must not lower the latch and let an already-announced version reappear.
    quiet(() => printVersionNotice({
        currentVersion: '1.6.7', latestVersion: '1.7.0', installKind: 'npm-global',
        cacheFile, message: 'stale',
    } as any));
    check('an older notice does not regress the latch', readCache(cacheFile).notifiedVersion === '1.8.0');
}

// ── 5c) An unprinted notice is re-offered, not silently consumed ──────
{
    const unprintedCache = path.join(tmpRoot, 'version_check_unprinted.json');
    const first = await startVersionNoticeCheck({
        ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', fetchImpl: stubFetch('1.9.0'),
    });
    check('an unprinted notice is produced', first && first.latestVersion === '1.9.0', JSON.stringify(first));
    check('an unprinted notice is not latched', readCache(unprintedCache).notifiedVersion === null);

    const second = await startVersionNoticeCheck({
        ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', force: true, fetchImpl: stubFetch('1.9.0'),
    });
    check('the same notice is offered again on the next run', second && second.latestVersion === '1.9.0', JSON.stringify(second));

    // The centralized flush wrapper must print and latch exactly like the
    // other print paths.
    await quietAsync(() => flushVersionNotice(Promise.resolve(second)));
    check('flushVersionNotice latches the displayed version', readCache(unprintedCache).notifiedVersion === '1.9.0');
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
        printVersionNoticeWhenReady(pending);
        check('printVersionNoticeWhenReady returns without awaiting', Date.now() - t0 < 100, `${Date.now() - t0}ms`);
        check('nothing is latched before the probe settles',
            readCache(whenReadyCache) === null);

        release({
            currentVersion: '1.0.0', latestVersion: '1.2.0', installKind: 'npm-global',
            cacheFile: whenReadyCache, message: 'x',
        });
        await new Promise((r) => setTimeout(r, 0));
        check('the notice is latched once the probe settles',
            readCache(whenReadyCache).notifiedVersion === '1.2.0');
    } finally {
        (console as any).log = orig;
    }
}

// ── 6) Up-to-date and ahead-of-registry installs stay silent ─────────
{
    const notice = await startVersionNoticeCheck({
        ...BASE, currentVersion: '1.8.0', force: true, now: 400_000_000, fetchImpl: stubFetch('1.8.0'),
    });
    check('installed version equal to latest is silent', notice === null);
}
{
    const notice = await startVersionNoticeCheck({
        ...BASE, currentVersion: '2.0.0', force: true, now: 500_000_000, fetchImpl: stubFetch('1.8.0'),
    });
    check('installed version ahead of latest is silent', notice === null);
}

// ── 7) Network failures are silent but still throttle ────────────────
{
    const freshCache = path.join(tmpRoot, 'version_check_offline.json');
    const calls = { n: 0 };
    const notice = await startVersionNoticeCheck({
        ...BASE, cacheFile: freshCache, now: 600_000_000, fetchImpl: stubFetch(new Error('ENOTFOUND'), calls),
    });
    check('a network failure yields no notice', notice === null);
    const cached = readCache(freshCache);
    check('a network failure still records the probe so it backs off',
        cached && cached.lastCheckMs === 600_000_000, JSON.stringify(cached));
    check('a failed probe is not latched as announced', cached && cached.notifiedVersion === null);

    const retryCalls = { n: 0 };
    await startVersionNoticeCheck({
        ...BASE, cacheFile: freshCache, force: false, now: 600_000_100, fetchImpl: stubFetch(new Error('ENOTFOUND'), retryCalls),
    });
    check('an offline node does not re-probe on the next start', retryCalls.n === 0, `n=${retryCalls.n}`);
}
{
    const httpFailCache = path.join(tmpRoot, 'version_check_http.json');
    const notice = await startVersionNoticeCheck({
        ...BASE, cacheFile: httpFailCache, now: 700_000_000,
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    check('a non-2xx registry response yields no notice', notice === null);
}
{
    const badBodyCache = path.join(tmpRoot, 'version_check_body.json');
    const notice = await startVersionNoticeCheck({
        ...BASE, cacheFile: badBodyCache, now: 800_000_000,
        fetchImpl: async () => ({ ok: true, json: async () => ({ notAVersion: 1 }) }),
    });
    check('a malformed registry body yields no notice', notice === null);
}
{
    // A hung registry must be cut off by the option override, not the 2s
    // default — this is the path `dexbot status` relies on to stay responsive.
    const timeoutCache = path.join(tmpRoot, 'version_check_timeout.json');
    const notice = await startVersionNoticeCheck({
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
        const notice = await startVersionNoticeCheck({
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
    const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: offCache, enabled: false, fetchImpl: stubFetch('9.9.9', calls) });
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
        const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: skipCache, fetchImpl: stubFetch('9.9.9', calls) });
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
    const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: noUrlCache, registryUrl: '', fetchImpl: stubFetch('9.9.9') });
    check('an empty REGISTRY_URL is silent', notice === null);
    check('an empty REGISTRY_URL writes no cache file', !fs.existsSync(noUrlCache));
}
{
    // A current version that cannot be read must not produce a bogus notice.
    const noVerCache = path.join(tmpRoot, 'version_check_nover.json');
    const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: noVerCache, currentVersion: '', fetchImpl: stubFetch('9.9.9') });
    check('an unreadable current version is silent', notice === null);
}

// ── 9) Cache corruption is survivable ────────────────────────────────
{
    const corruptCache = path.join(tmpRoot, 'version_check_corrupt.json');
    fs.writeFileSync(corruptCache, '{not json', { mode: 0o600 });
    const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: corruptCache, fetchImpl: stubFetch('1.9.0') });
    check('a corrupt cache does not break the check', notice && notice.latestVersion === '1.9.0', JSON.stringify(notice));
}
{
    const wrongVersionCache = path.join(tmpRoot, 'version_check_v0.json');
    fs.writeFileSync(wrongVersionCache, JSON.stringify({ version: 0, lastCheckMs: 9e15 }), { mode: 0o600 });
    const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: wrongVersionCache, fetchImpl: stubFetch('1.9.0') });
    check('a cache from a foreign schema version is ignored', notice && notice.latestVersion === '1.9.0');
}
{
    const badTypeCache = path.join(tmpRoot, 'version_check_badtype.json');
    fs.writeFileSync(badTypeCache, JSON.stringify({
        version: 1, lastCheckMs: 9e15, latestVersion: { nope: true }, notifiedVersion: null,
    }), { mode: 0o600 });
    const notice = await startVersionNoticeCheck({ ...BASE, cacheFile: badTypeCache, fetchImpl: stubFetch('1.9.0') });
    check('a cache with a non-string version field is ignored', notice && notice.latestVersion === '1.9.0');
}

// ── 10) Hint text adapts to the install layout ───────────────────────
{
    const gitCache = path.join(tmpRoot, 'version_check_git.json');
    const notice = await startVersionNoticeCheck({
        ...BASE, cacheFile: gitCache, installKind: 'git', currentVersion: '1.0.0',
        now: 900_000_000, fetchImpl: stubFetch('1.1.0'),
    });
    check('a git checkout gets the pull-and-restart hint',
        (notice && notice.message || '').includes('pull it and restart'), notice && notice.message);
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
