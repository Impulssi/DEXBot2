'use strict';

// Regression tests for scripts/update_layout.ts.
//
// The updater runs from inside the installed package and previously had a
// single "install root differs from `npm root -g`" dead-end for every layout
// that was not a direct npm global install. These cases pin the classification
// (npm global vs local vs pnpm/yarn global vs linked) and the exact command
// each layout must produce, plus the argv used to spawn the manager.

const assert = require('assert');
const path = require('path');

const {
    classifyInstallLayout,
    detectManagerFromPath,
    globalInstallArgs,
    globalInstallCommand,
    localInstallCommand,
    parseVersionLine,
    isDirectChildOf,
    isNodeModulesChild,
} = require('../scripts/update_layout');

const NPM_ROOT = '/opt/node/lib/node_modules';
const PNPM_ROOT = '/home/u/.local/share/pnpm/global/v11';
const YARN_ROOT = '/home/u/.config/yarn/global/node_modules';
const ROOTS = { npm: NPM_ROOT, pnpm: PNPM_ROOT, yarn: YARN_ROOT };
const EMPTY_ROOTS = { npm: '', pnpm: '', yarn: '' };

function check(name, fn) {
    fn();
    console.log(`  \u2713 ${name}`);
}

function testNpmGlobalIsInPlace() {
    const layout = classifyInstallLayout(path.join(NPM_ROOT, 'dexbot'), ROOTS, 'dexbot');
    assert.strictEqual(layout.kind, 'npm-global');
    assert.strictEqual(layout.manager, 'npm');
    assert.strictEqual(layout.autoUpdatable, true);
    assert.ok(layout.hint.includes('npm install -g dexbot@latest'), layout.hint);
}

function testNpmGlobalMatchesRealpathEquivalents() {
    // classify() resolves both sides; a trailing slash or ./ must not change it.
    const layout = classifyInstallLayout(`${NPM_ROOT}/./dexbot/`, ROOTS, 'dexbot');
    assert.strictEqual(layout.kind, 'npm-global');
}

function testLocalNpmDependencyIsNotInPlace() {
    const layout = classifyInstallLayout('/home/u/app/node_modules/dexbot', ROOTS, 'dexbot');
    assert.strictEqual(layout.kind, 'local');
    assert.strictEqual(layout.manager, null);
    assert.strictEqual(layout.autoUpdatable, false);
    // Must NOT recommend `npm update`: an exact pin is not moved by it.
    assert.ok(layout.hint.includes('npm install dexbot@latest'), layout.hint);
    assert.ok(/parent project/.test(layout.hint), layout.hint);
    assert.ok(!/npm update dexbot/.test(layout.hint), layout.hint);
}

function testLocalPnpmDependencyUsesPnpmInParent() {
    const layout = classifyInstallLayout(
        '/home/u/app/node_modules/.pnpm/dexbot@1.2.3/node_modules/dexbot',
        ROOTS,
        'dexbot'
    );
    assert.strictEqual(layout.kind, 'local');
    assert.strictEqual(layout.manager, 'pnpm');
    assert.strictEqual(layout.autoUpdatable, false);
    assert.ok(layout.hint.includes('pnpm add dexbot@latest'), layout.hint);
}

function testPnpmGlobalViaRoot() {
    const layout = classifyInstallLayout(
        path.join(PNPM_ROOT, 'abcdef', 'node_modules', 'dexbot'),
        ROOTS,
        'dexbot'
    );
    assert.strictEqual(layout.kind, 'pnpm-global');
    assert.strictEqual(layout.manager, 'pnpm');
    assert.strictEqual(layout.autoUpdatable, false);
    assert.ok(layout.hint.includes('pnpm add -g dexbot@latest'), layout.hint);
}

function testPnpmGlobalViaPathSignatureWhenRootUnavailable() {
    // `pnpm root -g` fails when its global bin dir is off PATH; the default
    // layout signature must still classify correctly.
    const layout = classifyInstallLayout(
        '/home/u/.local/share/pnpm/global/v11/abcdef/node_modules/dexbot',
        EMPTY_ROOTS,
        'dexbot'
    );
    assert.strictEqual(layout.kind, 'pnpm-global');
    assert.strictEqual(layout.manager, 'pnpm');
}

function testYarnGlobalViaRoot() {
    const layout = classifyInstallLayout(path.join(YARN_ROOT, 'dexbot'), ROOTS, 'dexbot');
    assert.strictEqual(layout.kind, 'yarn-global');
    assert.strictEqual(layout.manager, 'yarn');
    assert.strictEqual(layout.autoUpdatable, false);
    assert.ok(layout.hint.includes('yarn global add dexbot@latest'), layout.hint);
}

function testYarnGlobalViaPathSignature() {
    const layout = classifyInstallLayout(
        '/home/u/.config/yarn/global/node_modules/dexbot',
        EMPTY_ROOTS,
        'dexbot'
    );
    assert.strictEqual(layout.kind, 'yarn-global');
    assert.strictEqual(layout.manager, 'yarn');
}

function testLinkedInstallFallsBackToGlobalHint() {
    const layout = classifyInstallLayout('/home/u/dev/dexbot', ROOTS, 'dexbot');
    assert.strictEqual(layout.kind, 'linked');
    assert.strictEqual(layout.autoUpdatable, false);
    assert.ok(layout.hint.includes('npm install -g dexbot@latest'), layout.hint);
}

function testNestedPackageIsNotAChild() {
    // A package deeper than one level under node_modules is not a direct npm
    // global install; the updater must not treat it as one.
    const layout = classifyInstallLayout(
        '/opt/node/lib/node_modules/host/node_modules/dexbot',
        ROOTS,
        'dexbot'
    );
    assert.notStrictEqual(layout.kind, 'npm-global');
    assert.strictEqual(layout.autoUpdatable, false);
}

function testPnpmGlobalDetectedWhenSymlinkIsResolved() {
    // Node resolves symlinks by default, so a running pnpm install sees the
    // store path (<...>/global/vN/<hash>/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>),
    // not the tidy top-level symlink. It must still be recognized as global,
    // and -- with no roots available -- never confused with a local dep.
    const layout = classifyInstallLayout(
        '/home/u/.local/share/pnpm/global/v11/abcdef/node_modules/.pnpm/dexbot@1.6.11/node_modules/dexbot',
        EMPTY_ROOTS,
        'dexbot'
    );
    assert.strictEqual(layout.kind, 'pnpm-global');
    assert.strictEqual(layout.manager, 'pnpm');
    assert.strictEqual(layout.autoUpdatable, false);
}

function testLocalPnpmDepWithoutGlobalSegmentStaysLocal() {
    const layout = classifyInstallLayout(
        '/home/u/app/node_modules/.pnpm/dexbot@1.2.3/node_modules/dexbot',
        EMPTY_ROOTS,
        'dexbot'
    );
    assert.strictEqual(layout.kind, 'local');
    assert.strictEqual(layout.manager, 'pnpm');
}

function testParseVersionLine() {
    assert.strictEqual(parseVersionLine('1.6.11'), '1.6.11');
    assert.strictEqual(parseVersionLine(' 1.6.11\n'), '1.6.11');
    // npm notices may precede the version; the semver line must win.
    assert.strictEqual(parseVersionLine('npm notice update available\n1.7.0\n'), '1.7.0');
    assert.strictEqual(parseVersionLine('1.7.0\nnpm notice something'), '1.7.0');
    assert.strictEqual(parseVersionLine(''), '');
    assert.strictEqual(parseVersionLine('not-a-version'), '');
}

function testManagerCommands() {
    assert.deepStrictEqual(globalInstallArgs('npm', 'dexbot', '1.2.3'), ['install', '-g', 'dexbot@1.2.3']);
    assert.deepStrictEqual(globalInstallArgs('pnpm', 'dexbot'), ['add', '-g', 'dexbot@latest']);
    assert.deepStrictEqual(globalInstallArgs('yarn', 'dexbot'), ['global', 'add', 'dexbot@latest']);

    assert.strictEqual(globalInstallCommand('npm', 'dexbot'), 'npm install -g dexbot@latest');
    assert.strictEqual(globalInstallCommand('pnpm', 'dexbot', '9.9.9'), 'pnpm add -g dexbot@9.9.9');
    assert.strictEqual(globalInstallCommand('yarn', 'pkg'), 'yarn global add pkg@latest');

    assert.strictEqual(localInstallCommand('npm', 'dexbot'), 'npm install dexbot@latest');
    assert.strictEqual(localInstallCommand('pnpm', 'dexbot'), 'pnpm add dexbot@latest');
    assert.strictEqual(localInstallCommand('yarn', 'dexbot'), 'yarn add dexbot@latest');
    assert.strictEqual(localInstallCommand(null, 'dexbot'), 'npm install dexbot@latest');
}

function testPathPrimitives() {
    assert.strictEqual(isDirectChildOf('/a/b/c', '/a/b'), true);
    assert.strictEqual(isDirectChildOf('/a/b/c', '/a'), false);
    assert.strictEqual(isDirectChildOf('/a/b/c', ''), false);
    assert.strictEqual(isDirectChildOf('/a/b/c', '/a/b/c'), false);

    assert.strictEqual(isNodeModulesChild('/a/b/node_modules/c'), true);
    assert.strictEqual(isNodeModulesChild('/a/b/c'), false);

    assert.strictEqual(detectManagerFromPath('/x/node_modules/.pnpm/y/node_modules/z'), 'pnpm');
    assert.strictEqual(detectManagerFromPath('/x/pnpm/global/v11/h/node_modules/z'), 'pnpm');
    assert.strictEqual(detectManagerFromPath('/home/u/.config/yarn/global/node_modules/z'), 'yarn');
    assert.strictEqual(detectManagerFromPath('/opt/lib/node_modules/z'), null);
}

function main() {
    console.log('\n=== update layout tests ===');
    check('npm global is updated in place', testNpmGlobalIsInPlace);
    check('npm global matches realpath-equivalent input', testNpmGlobalMatchesRealpathEquivalents);
    check('local npm dependency is not updated in place', testLocalNpmDependencyIsNotInPlace);
    check('local pnpm dependency uses pnpm in the parent', testLocalPnpmDependencyUsesPnpmInParent);
    check('pnpm global detected via root', testPnpmGlobalViaRoot);
    check('pnpm global detected via path signature', testPnpmGlobalViaPathSignatureWhenRootUnavailable);
    check('pnpm global detected when symlink is resolved', testPnpmGlobalDetectedWhenSymlinkIsResolved);
    check('local pnpm dep without global segment stays local', testLocalPnpmDepWithoutGlobalSegmentStaysLocal);
    check('yarn global detected via root', testYarnGlobalViaRoot);
    check('yarn global detected via path signature', testYarnGlobalViaPathSignature);
    check('linked install falls back to global hint', testLinkedInstallFallsBackToGlobalHint);
    check('nested package is not a direct global child', testNestedPackageIsNotAChild);
    check('manager commands and argv', testManagerCommands);
    check('version output parsing', testParseVersionLine);
    check('path primitives', testPathPrimitives);
    console.log('update layout tests passed');
}

main();
