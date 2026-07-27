
/**
 * Resolve the DEXBot2 project root from any directory path inside the
 * project (source or dist layout).  When the input is the `dist/`
 * directory itself, the project root is its parent; otherwise the input
 * itself is the project root.
 *
 * Centralises the BUILD_DIR-aware check that was previously copy-pasted
 * across 40+ files as
 *     path.basename(dir) === BUILD_DIR ? path.dirname(dir) : dir
 */

import { path } from '../path_api';
import { isDistRuntime as isDistCodeRoot } from '../utils/build_dir';
function resolveProjectRoot(dirPath: string): string {
    return isDistCodeRoot(dirPath) ? path.dirname(dirPath) : dirPath;
}

// Centralised scripts root: the directory containing the entry-point scripts.
// At this module depth (modules/launcher/), it resolves to <root> (source)
// or <root>/dist (compiled).  All launcher modules should import this rather
// than computing it themselves with fragile __dirname arithmetic.
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..');

function stripKnownExtension(fileName: string) {
    return fileName.replace(/\.(?:[cm]?js|ts)$/i, '');
}

function buildRuntimeScriptPath(codeRoot: string, scriptSegments: string[]) {
    if (!Array.isArray(scriptSegments) || scriptSegments.length === 0) {
        throw new Error('scriptSegments must contain at least one path segment');
    }

    const scriptExt = isDistCodeRoot(codeRoot) ? '.js' : '.ts';
    const normalizedSegments = [...scriptSegments];
    const lastSegment = normalizedSegments.pop() as string;
    normalizedSegments.push(`${stripKnownExtension(lastSegment)}${scriptExt}`);
    return path.join(codeRoot, ...normalizedSegments);
}

function buildRuntimeScriptArgs({
    codeRoot,
    scriptSegments,
    scriptArgs = [],
}: {
    codeRoot: string;
    scriptSegments: string[];
    scriptArgs?: string[];
}) {
    const scriptPath = buildRuntimeScriptPath(codeRoot, scriptSegments);
    if (isDistCodeRoot(codeRoot)) {
        return [scriptPath, ...scriptArgs];
    }
    return ['--import', 'tsx', scriptPath, ...scriptArgs];
}

export { buildRuntimeScriptArgs, buildRuntimeScriptPath, isDistCodeRoot, resolveProjectRoot, SCRIPTS_ROOT }

