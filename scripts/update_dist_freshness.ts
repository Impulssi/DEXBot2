import fs from 'node:fs';
import path from 'node:path';

/**
 * Dist-bundle freshness helpers for the updater.
 *
 * `dist/` is gitignored, so git never reconciles it — only a TypeScript build
 * does. When a source update bypasses that build (a manual pull/checkout, or a
 * tsc run that skipped outputs via its incremental cache), the bundle can lag
 * its sources indefinitely while every later update reports "up to date".
 * These helpers detect that without invoking the compiler.
 */

/** Entry points the runtime needs at minimum; a missing one means a broken bundle. */
export const REQUIRED_DIST_ENTRIES = [
    'dexbot.js',
    'bot.js',
    'unlock.js',
    'pm2.js',
    'credential-daemon.js',
    'modules/dexbot_class.js',
    'scripts/update.js',
];

/** Roots compiled by the root tsconfig.json (`include`), used to map sources to dist. */
export const COMPILED_SOURCE_ROOTS = ['modules', 'market_adapter', 'scripts', 'analysis'];

/**
 * Relative directory prefixes the root `tsconfig.json` excludes from the
 * production build. The freshness model must mirror the compiler: a source the
 * build intentionally skips (e.g. tests compiled by `tsconfig.tests.json`) has
 * no dist counterpart, and treating it as one makes the updater refuse a
 * perfectly fresh bundle. Only plain directory paths are treated as prefixes;
 * glob/negated patterns are ignored so this stays conservative and never
 * over-excludes.
 *
 * @param root - Project root containing `tsconfig.json`.
 */
export function readBuildExcludePrefixes(root: string): string[] {
    try {
        const raw = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const exclude = Array.isArray(parsed?.exclude) ? parsed.exclude : [];
        return exclude
            .filter((entry: unknown): entry is string =>
                typeof entry === 'string' && !entry.includes('*') && !entry.startsWith('!'))
            .map((entry: string) => entry.replace(/\\/g, '/').replace(/\/+$/, ''))
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}

/**
 * Collect every `.ts` file the root `tsconfig.json` compiles to `dist/<rel>.js`,
 * skipping declaration-only files and nested `node_modules`. The mapping is
 * 1:1 because the build runs a single root `tsc` with `rootDir: "."`.
 *
 * @param root - Project root containing `tsconfig.json`.
 * @param buildDir - Output directory name (e.g. `dist`).
 */
export function collectCompiledSources(root: string, buildDir: string): Array<{ src: string; dist: string }> {
    const out: Array<{ src: string; dist: string }> = [];
    const excluded = readBuildExcludePrefixes(root);
    const isExcluded = (rel: string) => excluded.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
    const add = (src: string, rel: string) => {
        if (isExcluded(rel)) return;
        out.push({ src, dist: path.join(root, buildDir, rel.replace(/\.ts$/, '.js')) });
    };
    const walk = (dir: string, rel: string) => {
        let entries: import('node:fs').Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules' && !isExcluded(childRel)) walk(path.join(dir, entry.name), childRel);
            } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                add(path.join(dir, entry.name), childRel);
            }
        }
    };
    try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                add(path.join(root, entry.name), entry.name);
            }
        }
    } catch (_) {}
    for (const sourceRoot of COMPILED_SOURCE_ROOTS) {
        const base = path.join(root, sourceRoot);
        if (fs.existsSync(base)) walk(base, sourceRoot);
    }
    return out;
}

/**
 * Return the required dist entries that are missing under `buildDir`.
 * Shared by the git flow's freshness check and the npm flow's post-install
 * verification so the required set lives in one place.
 *
 * @param root - Project root containing `tsconfig.json`.
 * @param buildDir - Output directory name (e.g. `dist`).
 */
export function findMissingDistEntries(root: string, buildDir: string): string[] {
    return REQUIRED_DIST_ENTRIES.filter((rel) => !fs.existsSync(path.join(root, buildDir, rel)));
}

/**
 * Describe whether `dist/` needs a rebuild. Returns the first problem found so
 * the caller can log a precise reason instead of a generic "stale" message.
 *
 * @param root - Project root containing `tsconfig.json`.
 * @param buildDir - Output directory name (e.g. `dist`).
 */
export function inspectDistBundle(root: string, buildDir: string): { needsRebuild: boolean; reason: string } {
    const missing = findMissingDistEntries(root, buildDir);
    if (missing.length > 0) {
        return { needsRebuild: true, reason: `is missing ${buildDir}/${missing[0]}` };
    }
    for (const { src, dist } of collectCompiledSources(root, buildDir)) {
        let distStat: import('node:fs').Stats;
        try { distStat = fs.statSync(dist); } catch {
            return { needsRebuild: true, reason: `is missing ${path.relative(root, dist)}` };
        }
        let srcStat: import('node:fs').Stats;
        try { srcStat = fs.statSync(src); } catch { continue; }
        if (distStat.mtimeMs < srcStat.mtimeMs) {
            return { needsRebuild: true, reason: `is older than ${path.relative(root, src)}` };
        }
    }
    return { needsRebuild: false, reason: '' };
}
