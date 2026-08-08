const { path } = require('../../modules/path_api');
const { BUILD_DIR } = require('../../modules/constants');

const MODULES_SEG = path.sep + 'modules' + path.sep;

function _deriveDistPath(sourcePath) {
    const normalized = path.normalize(sourcePath);
    const idx = normalized.lastIndexOf(MODULES_SEG);
    if (idx === -1) return null;

    const root = normalized.slice(0, idx);
    const relative = normalized.slice(idx + 1);
    const cleaned = relative.replace(/\.ts$/i, '.js');
    return path.join(root, BUILD_DIR, cleaned);
}

function setCachedModule(modulePath, exports, opts = {}) {
    const original = require.cache[modulePath];
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    } as any;

    const tsPath = modulePath.replace(/\.js$/i, '.ts');
    if (tsPath !== modulePath) {
        require.cache[tsPath] = require.cache[modulePath];
    }

    if ((opts as any).mirrorDist !== false) {
        const distPath = _deriveDistPath(modulePath);
        if (distPath) {
            require.cache[distPath] = require.cache[modulePath];
        }
    }

    return original;
}

function restoreCachedModule(modulePath, original, opts = {}) {
    if (original) {
        require.cache[modulePath] = original;
    } else {
        delete require.cache[modulePath];
    }

    const tsPath = modulePath.replace(/\.js$/i, '.ts');
    if (tsPath !== modulePath) {
        if (original) {
            require.cache[tsPath] = original;
        } else {
            delete require.cache[tsPath];
        }
    }

    if ((opts as any).mirrorDist !== false) {
        const distPath = _deriveDistPath(modulePath);
        if (distPath) {
            delete require.cache[distPath];
        }
    }
}

module.exports = {
    restoreCachedModule,
    setCachedModule,
} as any;
