import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

let startupManifest = {};

export function initialize(data) {
    const p = data && data.manifestPath;
    if (!p) return;
    try {
        startupManifest = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
        startupManifest = {};
    }
}

function currentManifest() {
    const p = process.env.DEXBOT_ESM_MOCK_MANIFEST;
    if (!p) return startupManifest;
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
        return startupManifest;
    }
}

function toStubUrl(stubPath) {
    return pathToFileURL(stubPath).href;
}

export async function load(url, context, nextLoad) {
    if (url.startsWith('file://')) {
        let p = null;
        try { p = new URL(url).pathname; } catch { /* not a file url */ }
        const entry = p ? currentManifest()[p] : undefined;
        if (p && entry) {
            const lines = [
                `import __mock from ${JSON.stringify(toStubUrl(entry.stub))};`,
                'export default __mock;',
                ...entry.names.map((n) => `export const ${n} = __mock[${JSON.stringify(n)}];`),
            ];
            return {
                format: 'module',
                source: lines.join('\n') + '\n',
                shortCircuit: true,
            };
        }
    }
    return nextLoad(url, context);
}
