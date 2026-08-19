import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

import { path } from '../path_api.js';
import { isDistRuntime as isDistCodeRoot } from '../utils/build_dir.js';

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

export { buildRuntimeScriptArgs, buildRuntimeScriptPath, isDistCodeRoot, SCRIPTS_ROOT }

