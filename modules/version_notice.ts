/**
 * modules/version_notice.ts - Passive version status + "new version" notice.
 *
 * Reports the INSTALLED version against the published `latest` on every start
 * and in `dexbot stat`, and prints a one-time hint when a newer DEXBot2 release
 * exists — without ever changing code on its own. This is deliberately
 * ORTHOGONAL to `UPDATER.ACTIVE` (the automated updater, default OFF): a bot
 * handling real funds must never silently change its own code, but the
 * operator still deserves to KNOW a fix or a breaking change landed. The
 * opt-out lives in `UPDATER.NOTICE_ENABLED` so it can be tuned independently of
 * the updater.
 *
 * ===============================================================================
 * DESIGN CONSTRAINTS
 * ===============================================================================
 *
 * 1. NEVER BLOCKS STARTUP. `startVersionStatusCheck()` returns a promise
 *    immediately and resolves with a `VersionStatus` (or null when the check is
 *    disabled). Callers start it early and `await` it late, so the round-trip
 *    overlaps work that is already happening (BitShares connection, password
 *    prompt).
 * 2. NEVER THROWS. Every failure path — offline, DNS failure, slow registry,
 *    unreadable cache, browser — resolves to `null`.
 * 3. NO SUBPROCESSES. The registry is queried with a single HTTPS GET and a
 *    hard timeout. `execSync('npm view ...')` (as used by `dexbot update`)
 *    costs 1-3s of spawn and hard-depends on the npm CLI, neither of which is
 *    acceptable on the launcher critical path.
 * 4. THROTTLED + NOTIFY-ONCE. A check runs at most once per
 *    `UPDATER.NOTICE_INTERVAL_MS`, and the same version is announced only once
 *    (`notifiedVersion` in the cache) so an ignored notice does not nag on
 *    every restart. A new published version resets that latch. The latch is
 *    committed by `printVersionStatus` only AFTER the notice is displayed, so a
 *    launcher path that returns without printing cannot silently consume it —
 *    it is re-offered once the throttle window expires. A throttled run still
 *    reports a status (from the cached observation) so `dexbot stat` answers
 *    "am I current?" without spending a request.
 * 4b. ONE IMPLEMENTATION. Every consumer (`unlock`, `pm2`, `dexbot stat`) goes
 *    through `startVersionStatusCheck` → `printVersionStatus`; the colour of the
 *    status line, the hint wording and the latch all live here, so no caller can
 *    drift from another.
 * 5. SILENT WHEN DISABLED. `Config.DEXBOT_SKIP_VERSION_NOTICE=1` (tests, CI,
 *    automation) or `UPDATER.NOTICE_ENABLED: false` short-circuits before any
 *    network or filesystem work.
 *
 * Cache layout mirrors `modules/node_health_cache.ts` and lives in the profiles
 * dir (never in the package dir — npm reinstalls wipe that).
 */

import { path } from './path_api.js';
import { UPDATER } from './constants.js';
import { PATHS, isGlobalNpmPackageDir } from './paths.js';
import { Config } from './config.js';
import { hasProcess } from './env.js';
import { getStorage } from './storage/index.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { CLI_COLORS } from './cli_colors.js';

const storage = getStorage();
const { readJSON } = storage;

/** How the running copy was installed — selects the hint text. */
export type InstallKind = 'npm-global' | 'git' | 'other';

/**
 * The pending one-time announcement: what the operator is told when a newer
 * release exists and has not been displayed yet. It carries DATA only — the
 * wording and colour are rendered by `printVersionStatus`, so there is exactly
 * one place that decides how a version verdict looks.
 */
export interface VersionNotice {
    currentVersion: string;
    latestVersion: string;
    installKind: InstallKind;
    /** Cache file `printVersionStatus` advances once the notice is displayed.
     *  Internal plumbing; callers should not read it. */
    cacheFile: string;
}

/** Green when current, orange when a newer release exists, gray when unknown. */
export type VersionState = 'up-to-date' | 'update-available' | 'unknown';

export interface VersionStatus {
    /** Installed version — `Config.VERSION` unless overridden. */
    currentVersion: string;
    /** Latest version observed this run, or from the throttle cache. Null when
     *  the probe failed, which renders as `unknown`. */
    latestVersion: string | null;
    installKind: InstallKind;
    state: VersionState;
    /** Cache file backing the throttle. Plumbing; callers should not read it. */
    cacheFile: string;
    /** Present only when a NEWER version exists AND it has not been announced
     *  yet. Carries the one-time hint; `printVersionStatus` is the only path
     *  that latches it. */
    notice: VersionNotice | null;
}

interface VersionCheckCache {
    version: number;
    updatedAt: string;
    /** Epoch ms of the last registry probe, successful or not. Drives the throttle. */
    lastCheckMs: number;
    /** Latest version observed — null when the probe failed. */
    latestVersion: string | null;
    /** Version already announced to the operator, so it is never repeated. */
    notifiedVersion: string | null;
}

export interface VersionNoticeOptions {
    /** Override the installed version (defaults to `Config.VERSION`). */
    currentVersion?: string;
    /** Override the cache location (tests). */
    cacheFile?: string;
    /** Override the throttle window in ms; `< 0` forces a check. */
    intervalMs?: number;
    /** Override the registry URL (tests). Pass '' to model an unconfigured setup. */
    registryUrl?: string;
    /** Override `UPDATER.NOTICE_ENABLED` (tests). */
    enabled?: boolean;
    /** Override install-kind detection (tests). */
    installKind?: InstallKind;
    /** Injectable fetch, for offline/hermetic tests. */
    fetchImpl?: (url: string, init: any) => Promise<any>;
    /** Injected clock (tests). */
    now?: number;
    /** Ignore the throttle window. */
    force?: boolean;
    /** Override the network timeout in ms (tests; a shorter `dexbot status`). */
    timeoutMs?: number;
}

const CACHE_VERSION = 1;
/** Matches UPDATER.NOTICE_TIMEOUT_MS default; kept local so a malformed
 *  general.settings.json can never turn the probe into an open-ended hang. */
const MAX_TIMEOUT_MS = 10_000;

/**
 * Minimal semver comparison for `major.minor.patch` strings.
 * Returns negative when a < b, 0 when equal, positive when a > b.
 *
 * Prerelease and build metadata are stripped: `1.6.7-beta.1` and `1.6.7`
 * compare EQUAL. That is the intended reading for an update hint — a locally
 * built prerelease is not "older" than the published release, and comparing it
 * as `1.6.7.1 > 1.6.7` would permanently hide real updates from anyone
 * running a source checkout. A non-numeric segment degrades to 0 rather than
 * producing NaN ordering.
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: any) =>
        String(v ?? '').trim().split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
    const na = parse(a);
    const nb = parse(b);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
        const va = na[i] ?? 0;
        const vb = nb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
    }
    return 0;
}

/** Classify the running install without spawning anything. */
export function detectInstallKind(projectRoot: string = PATHS.PROJECT_ROOT): InstallKind {
    if (isGlobalNpmPackageDir(projectRoot)) return 'npm-global';
    try {
        if (storage.exists(path.join(projectRoot, '.git'))) return 'git';
    } catch {
        /* fall through to 'other' */
    }
    return 'other';
}

/**
 * The single status line, shared by `dexbot stat` and every launcher start.
 *
 * GREEN when the install matches the registry, ORANGE when a newer release
 * exists, GRAY when the probe could not answer (offline / throttled with no
 * prior observation) — an unknown answer must never be rendered as "up to
 * date". The installed version is always named, so a caller never needs a
 * second "DEXBot2 vX.Y.Z" header of its own.
 */
export function formatVersionStatusLine(status: Pick<VersionStatus, 'currentVersion' | 'latestVersion' | 'state'>): string {
    const c = CLI_COLORS;
    const current = `DEXBot2 v${status.currentVersion}`;
    if (status.state === 'up-to-date') {
        return `${current}  ${c.brightGreen}✓${c.reset} ${c.greenBold}Your version is up to date.${c.reset}`;
    }
    if (status.state === 'update-available') {
        return `${current}  ${c.orange}⬆${c.reset} ${c.orange}A new version is available: v${status.latestVersion}.${c.reset}`;
    }
    return `${current}  ${c.gray}? Could not check for a newer version.${c.reset}`;
}

/**
 * Hint text. `dexbot update` is the correct verb for BOTH layouts: the npm
 * flow does `npm install -g <pkg>@<latest>`, the git flow does
 * `fetch` + `pull` + rebuild + runtime restart. `update` is only complete
 * once active bots have been restarted onto the new code, which a bare
 * `git pull` in a terminal would not do.
 */
function formatVersionHint(installKind: InstallKind): string {
    return installKind === 'git'
        ? `Run \`dexbot update\` to pull it and restart your bots.`
        : `Run \`dexbot update\` to install it and restart your bots.`;
}

function readCache(file: string): VersionCheckCache | null {
    try {
        const payload = readJSON(file);
        if (!payload || payload.version !== CACHE_VERSION) return null;
        if (!Number.isFinite(payload.lastCheckMs)) return null;
        // Reject a foreign schema rather than trusting hand-edited types: a
        // non-string version would otherwise flow into compareVersions.
        if (payload.latestVersion != null && typeof payload.latestVersion !== 'string') return null;
        if (payload.notifiedVersion != null && typeof payload.notifiedVersion !== 'string') return null;
        return payload as VersionCheckCache;
    } catch {
        return null;
    }
}

function writeCache(file: string, cache: VersionCheckCache): void {
    try {
        writeJsonFileAtomic(file, cache);
    } catch {
        // A read-only or full profiles dir must never fail a startup.
    }
}

function resolveTimeoutMs(override?: number): number {
    const raw = override !== undefined ? Number(override) : Number((UPDATER as any)?.NOTICE_TIMEOUT_MS);
    if (!Number.isFinite(raw) || raw <= 0) return 2_000;
    return Math.min(raw, MAX_TIMEOUT_MS);
}

/**
 * Fetch the published `latest` version. Returns null on ANY failure — an
 * offline node, a proxy, a 404, a malformed body. Never throws.
 */
async function fetchLatestVersion(registryUrl: string, timeoutMs: number, fetchImpl?: any): Promise<string | null> {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return null;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    // The attempt never rejects, so racing it cannot leak an unhandled
    // rejection. The enclosing timeout is a HARD backstop: it resolves even
    // when no AbortController exists or a custom fetch ignores the signal, so
    // the "never blocks startup" guarantee does not depend on either. Without
    // it, a hung registry socket could stall a terminal `flushVersionStatus`
    // ahead of `process.exit()` and freeze `dexbot start`.
    const attempt = (async (): Promise<string | null> => {
        try {
            const res = await doFetch(registryUrl, {
                method: 'GET',
                headers: { accept: 'application/json' },
                signal: controller?.signal,
            });
            if (!res || res.ok === false) return null;
            const body = await res.json();
            const version = body?.version;
            if (typeof version !== 'string' || !version.trim()) return null;
            return version.trim();
        } catch {
            return null;
        }
    })();

    let timer: any = null;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            try { controller?.abort(); } catch { /* best-effort cancel */ }
            resolve(null);
        }, timeoutMs);
    });

    try {
        return await Promise.race([attempt, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Assemble a status; `includeNotice` is false on the throttled path, which
 *  reports the cached observation but never re-announces. */
function buildVersionStatus(
    currentVersion: string,
    latestVersion: string | null,
    installKind: InstallKind,
    cacheFile: string,
    includeNotice: boolean,
): VersionStatus {
    const state: VersionState = !latestVersion
        ? 'unknown'
        : compareVersions(currentVersion, latestVersion) < 0 ? 'update-available' : 'up-to-date';
    const notice = state === 'update-available' && includeNotice && latestVersion
        ? { currentVersion, latestVersion, installKind, cacheFile }
        : null;
    return { currentVersion, latestVersion, installKind, state, cacheFile, notice };
}

/**
 * Start the check. Resolves with the installed-vs-published status, plus a
 * `notice` when a NEWER version exists and that version has not been
 * announced yet. Resolves null only when the whole feature is switched off.
 * Rejects never.
 */
export function startVersionStatusCheck(options: VersionNoticeOptions = {}): Promise<VersionStatus | null> {
    // Every early return is a resolved null so callers can always await.
    const done = (value: VersionStatus | null | undefined): Promise<VersionStatus | null> =>
        Promise.resolve(value ?? null);

    if (!hasProcess()) return done(null);
    if (Config.DEXBOT_SKIP_VERSION_NOTICE) return done(null);
    const noticeEnabled = options.enabled ?? (UPDATER as any)?.NOTICE_ENABLED !== false;
    if (!noticeEnabled) return done(null);

    const cacheFile = options.cacheFile || PATHS.PROFILES.VERSION_CHECK_JSON;
    const now = options.now ?? Date.now();
    const intervalMs = options.intervalMs ?? Number((UPDATER as any)?.NOTICE_INTERVAL_MS ?? 0);
    const previous = readCache(cacheFile);

    // `??` (not `||`) so an explicitly empty current version is reported as
    // "unknown" and stays silent rather than falling back to a real version.
    const currentVersion = options.currentVersion ?? Config.VERSION;
    if (!currentVersion) return done(null);

    // `!== undefined` (not `||`) so an explicit empty string models a
    // deliberately unconfigured registry instead of falling back to UPDATER.
    const registryUrl = options.registryUrl !== undefined ? options.registryUrl : (UPDATER as any)?.REGISTRY_URL;
    if (!registryUrl) {
        // No registry configured — do not even write a cache entry, so
        // enabling it later takes effect on the very next start.
        return done(null);
    }
    const installKind = options.installKind || detectInstallKind();

    // Throttle: a recent probe (successful OR failed) means stay quiet, so an
    // offline node never pays the timeout on every single restart. The cached
    // observation still answers "am I current?" without spending a request.
    if (!options.force && Number.isFinite(intervalMs) && intervalMs > 0 && previous) {
        if (now - previous.lastCheckMs < intervalMs) {
            return done(buildVersionStatus(currentVersion, previous.latestVersion, installKind, cacheFile, false));
        }
    }

    return (async () => {
        const latestVersion = await fetchLatestVersion(registryUrl, resolveTimeoutMs(options.timeoutMs), options.fetchImpl);

        // Record the observation but DO NOT latch here: `notifiedVersion` is
        // advanced by `printVersionStatus` only once the hint is displayed.
        const base: VersionCheckCache = {
            version: CACHE_VERSION,
            updatedAt: new Date(now).toISOString(),
            lastCheckMs: now,
            latestVersion: latestVersion ?? null,
            notifiedVersion: previous?.notifiedVersion ?? null,
        };
        writeCache(cacheFile, base);

        const status = buildVersionStatus(currentVersion, latestVersion, installKind, cacheFile, true);
        // Same version already announced: keep reporting the state, drop only
        // the one-time hint.
        if (status.notice && previous?.notifiedVersion === status.notice.latestVersion) {
            return { ...status, notice: null };
        }
        return status;
    })().catch(() => null);
}

/**
 * Advance the notify-once latch for a notice that was actually displayed.
 * Separate from the probe so a notice the caller never surfaces cannot be
 * silently consumed — the next launcher run re-offers it. The latch only ever
 * moves forward, so a registry that briefly serves an older `latest`
 * (dist-tag rollback) cannot make an already-announced version reappear.
 */
function latchVersionNotice(notice: VersionNotice): void {
    try {
        const existing = readCache(notice.cacheFile);
        const announced = existing?.notifiedVersion ?? null;
        if (announced && compareVersions(announced, notice.latestVersion) >= 0) return;
        const next: VersionCheckCache = {
            version: CACHE_VERSION,
            updatedAt: existing?.updatedAt ?? new Date().toISOString(),
            lastCheckMs: existing?.lastCheckMs ?? 0,
            latestVersion: existing?.latestVersion ?? notice.latestVersion,
            notifiedVersion: notice.latestVersion,
        };
        writeCache(notice.cacheFile, next);
    } catch {
        // Best-effort: a read-only profiles dir must never fail a startup.
    }
}

/**
 * Print the status line (plus the install hint when a NEW, unannounced
 * version exists) and commit the notify-once latch for that hint. The single
 * print path for every caller, so latching cannot drift from display.
 */
export function printVersionStatus(status: VersionStatus | null | undefined, options: { indent?: string; surround?: boolean } = {}): void {
    if (!status) return;
    const c = CLI_COLORS;
    const indent = options.indent ?? '  ';
    const surround = options.surround !== false;
    if (surround) console.log();
    console.log(`${indent}${formatVersionStatusLine(status)}`);
    if (status.notice) {
        console.log(`${indent}  ${c.gray}${formatVersionHint(status.installKind)}${c.reset}`);
        latchVersionNotice(status.notice);
    }
    if (surround) console.log();
}

/**
 * Run the check and print the status/notice to stdout. Convenience wrapper
 * for call sites with nothing to overlap (e.g. `dexbot status`). Returns the
 * status that was printed, or null when the feature is switched off.
 */
export async function maybePrintVersionStatus(
    options: VersionNoticeOptions & { indent?: string; surround?: boolean } = {},
): Promise<VersionStatus | null> {
    const status = await startVersionStatusCheck(options);
    printVersionStatus(status, { indent: options.indent, surround: options.surround });
    return status;
}

/**
 * Await an already-started check and print its status. The single flush path
 * for callers (`unlock.ts`, `pm2.ts`) that start the probe early and surface it
 * only at a terminal point, so the await+print pair is not reimplemented per
 * call site.
 */
export async function flushVersionStatus(pending: Promise<VersionStatus | null>): Promise<void> {
    printVersionStatus(await pending);
}

/**
 * Print the status when the probe settles, WITHOUT awaiting it. For launch
 * paths that must never delay the bot start — the resident process outlives the
 * probe, so there is no `process.exit()` to truncate it.
 */
export function printVersionStatusWhenReady(pending: Promise<VersionStatus | null>): void {
    void pending.then(printVersionStatus, () => {});
}
