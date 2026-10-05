import path from 'node:path';

/**
 * Install-layout detection for the updater.
 *
 * The updater runs from *inside* the installed package, so the layout it finds
 * itself in decides everything: whether it can replace itself in place, which
 * package manager owns the tree, and which command the operator must run when
 * it cannot. Keeping this pure (no fs, no child_process, roots passed in) makes
 * every branch table-testable without touching a real global install.
 *
 * Supported layouts:
 *  - npm global      -> in-place `npm install -g` is safe (stable directory)
 *  - pnpm global     -> detected, but NOT updated in place (content-addressed
 *                       store: the running process points at a version-hashed
 *                       directory that the next `pnpm add -g` abandons)
 *  - yarn global     -> detected, NOT updated in place (same reasoning; the
 *                       layout also differs across Yarn 1 / Berry)
 *  - local dependency-> the parent project's lockfile owns the version
 *  - linked/unknown  -> `npm link`, custom prefixes, nested packages
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export type LayoutKind =
    | 'npm-global'
    | 'pnpm-global'
    | 'yarn-global'
    | 'local'
    | 'linked';

export interface GlobalRoots {
    /** `npm root -g` (e.g. <prefix>/lib/node_modules). '' when unavailable. */
    npm: string;
    /** `pnpm root -g` (e.g. $PNPM_HOME/global/v11). '' when unavailable. */
    pnpm: string;
    /** Yarn global node_modules (e.g. ~/.config/yarn/global/node_modules). */
    yarn: string;
}

export interface InstallLayout {
    kind: LayoutKind;
    /** Manager that owns the install, when it can be inferred. */
    manager: PackageManager | null;
    /** True only when the updater may replace the install in place. */
    autoUpdatable: boolean;
    /** Exact, copy-pasteable command for this layout (always present). */
    hint: string;
}

function normalize(p: string): string {
    return path.resolve(p);
}

/** Path with forward slashes, for stable segment matching on every platform. */
function slashPath(p: string): string {
    return normalize(p).split(path.sep).join('/');
}

/**
 * Paths are case-insensitive on Windows; compare accordingly so a drive-letter
 * or username casing difference between PROJECT_ROOT and a CLI-reported root
 * does not turn a valid global install into a "local" one.
 */
function samePath(a: string, b: string): boolean {
    const na = normalize(a);
    const nb = normalize(b);
    return process.platform === 'win32'
        ? na.toLowerCase() === nb.toLowerCase()
        : na === nb;
}

/** True when `root` is a direct child of `globalRoot` (both resolved first). */
export function isDirectChildOf(root: string, globalRoot: string): boolean {
    if (!globalRoot) return false;
    return samePath(path.dirname(normalize(root)), globalRoot);
}

/** True when `root` sits directly under a directory named `node_modules`. */
export function isNodeModulesChild(root: string): boolean {
    return path.basename(path.dirname(normalize(root))) === 'node_modules';
}

/**
 * Manager inferred from install-shape markers in the path. Used when the
 * manager's own `root`/`dir` query is unavailable or does not line up.
 */
export function detectManagerFromPath(root: string): PackageManager | null {
    const p = slashPath(root);
    if (/(?:^|\/)\.pnpm\//.test(p) || /\/pnpm\/global\//.test(p)) return 'pnpm';
    if (/\/yarn\/(?:global|berry)\//.test(p) || /\/\.yarn\/(?:global|berry)\//.test(p)) return 'yarn';
    return null;
}

/**
 * pnpm's global tree is `<pnpmRoot>/<hash>/node_modules/<pkg>` (pnpm >= 9) or
 * `<pnpmRoot>/<version>/node_modules/<pkg>` (older). Either way the package is
 * one level below a `node_modules` that is itself one level below `pnpmRoot`.
 */
function isUnderPnpmRoot(root: string, pnpmRoot: string): boolean {
    if (!pnpmRoot) return false;
    const rel = path.relative(normalize(pnpmRoot), normalize(root));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const parts = rel.split(path.sep);
    return parts.length >= 3 && parts[parts.length - 2] === 'node_modules';
}

/**
 * Fallback pnpm-global signature when `pnpm root -g` could not be queried.
 *
 * Two shapes occur because Node resolves symlinks by default:
 *  - symlink preserved: <pnpmRoot>/<hash>/node_modules/<pkg>
 *  - symlink resolved:   <pnpmRoot>/<hash>/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>
 * Both carry a `global/<version>` segment, which a local dependency never does.
 */
function looksLikePnpmGlobal(root: string): boolean {
    const p = slashPath(root);
    if (/\/global\/v?\d+\/[^/]+\/node_modules\/[^/]+$/.test(p)) return true;
    return /\/global\/v?\d+\//.test(p) && /\/node_modules\/\.pnpm\//.test(p);
}

/** Fallback yarn-global signature when `yarn global dir` could not be queried. */
function looksLikeYarnGlobal(root: string): boolean {
    return /\/(?:\.?yarn)\/global\/node_modules\/[^/]+$/.test(slashPath(root));
}

export function globalInstallCommand(manager: PackageManager | null, pkg: string, version = 'latest'): string {
    switch (manager) {
        case 'pnpm':
            return `pnpm add -g ${pkg}@${version}`;
        case 'yarn':
            return `yarn global add ${pkg}@${version}`;
        default:
            return `npm install -g ${pkg}@${version}`;
    }
}

export function localInstallCommand(manager: PackageManager | null, pkg: string, version = 'latest'): string {
    switch (manager) {
        case 'pnpm':
            return `pnpm add ${pkg}@${version}`;
        case 'yarn':
            return `yarn add ${pkg}@${version}`;
        default:
            return `npm install ${pkg}@${version}`;
    }
}

/** argv for spawning the global install with the owning manager. */
export function globalInstallArgs(manager: PackageManager, pkg: string, version = 'latest'): string[] {
    switch (manager) {
        case 'pnpm':
            return ['add', '-g', `${pkg}@${version}`];
        case 'yarn':
            return ['global', 'add', `${pkg}@${version}`];
        default:
            return ['install', '-g', `${pkg}@${version}`];
    }
}

export function classifyInstallLayout(root: string, roots: GlobalRoots, pkgName: string): InstallLayout {
    const resolved = normalize(root);

    // ── Global installs ──────────────────────────────────────────────
    // npm is the only layout the updater can swap in place: its package
    // directory is stable across reinstalls.
    if (isDirectChildOf(resolved, roots.npm)) {
        return {
            kind: 'npm-global',
            manager: 'npm',
            autoUpdatable: true,
            hint: globalInstallCommand('npm', pkgName),
        };
    }
    if (isUnderPnpmRoot(resolved, roots.pnpm) || looksLikePnpmGlobal(resolved)) {
        return {
            kind: 'pnpm-global',
            manager: 'pnpm',
            autoUpdatable: false,
            hint:
                `This is a pnpm global install. Update it with \`${globalInstallCommand('pnpm', pkgName)}\`. ` +
                'pnpm keeps the running copy in a version-hashed store directory, so dexbot cannot safely ' +
                'replace it and restart itself in place.',
        };
    }
    if (isDirectChildOf(resolved, roots.yarn) || looksLikeYarnGlobal(resolved)) {
        return {
            kind: 'yarn-global',
            manager: 'yarn',
            autoUpdatable: false,
            hint:
                `This is a yarn global install. Update it with \`${globalInstallCommand('yarn', pkgName)}\`, ` +
                'then restart dexbot.',
        };
    }

    // ── Local dependency ─────────────────────────────────────────────
    // The parent project's package.json/lockfile owns the version. An in-place
    // global install would update a *different* copy, and the next `npm ci`
    // would revert it. Note: `npm update` only moves within the declared range
    // — an exact pin needs `install`, which is why the hint uses `install`.
    if (isNodeModulesChild(resolved)) {
        const manager = detectManagerFromPath(resolved);
        return {
            kind: 'local',
            manager,
            autoUpdatable: false,
            hint:
                `This is a local dependency, not a global install. Run ` +
                `\`${localInstallCommand(manager, pkgName)}\` in the parent project directory ` +
                '(an exact version pin is not moved by `npm update`).',
        };
    }

    // ── Linked / unrecognized ────────────────────────────────────────
    const manager = detectManagerFromPath(resolved);
    return {
        kind: 'linked',
        manager,
        autoUpdatable: false,
        hint:
            `This install is linked or uses an unrecognized layout (e.g. \`npm link\`, a custom --prefix, ` +
            `or a nested package). Update the linked source checkout, or reinstall globally with ` +
            `\`${globalInstallCommand('npm', pkgName)}\`.`,
    };
}

/**
 * parseVersionLine: Pick the last semver-looking line from a CLI's stdout.
 *
 * `npm view <pkg> version` is normally a single line, but npm can prepend
 * notices; matching a version shape instead of trusting the last line keeps a
 * notice from being compared as a version.
 */
export function parseVersionLine(stdout: string): string {
    const lines = String(stdout || '').split('\n').map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\d+\.\d+\.\d+/.test(lines[i])) return lines[i];
    }
    return '';
}
