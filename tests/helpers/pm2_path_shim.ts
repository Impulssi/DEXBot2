'use strict';

/**
 * Hermetic `pm2` binary shim for launcher tests.
 *
 * pm2.ts imports { spawn } from 'node:child_process' statically, so its ESM
 * import binding cannot be intercepted by replacing childProcess.spawn, and
 * frozen compiled ESM namespaces cannot be patched at all. Instead this
 * helper puts a recording fake `pm2` executable at the front of PATH. Every
 * invocation is recorded ({ args, cwd, env subset }) so tests can assert on
 * spawned commands and child env hygiene, while scripted stdout/stderr/exit
 * codes keep the runner fully offline.
 *
 * The shim bakes absolute log/spec paths into its own source because spawned
 * children may receive a scrubbed env (buildScopedChildEnv) that drops any
 * DEXBOT_TEST_* variable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function buildShimScript(logPath, specPath) {
    const lines = [
        '#!/usr/bin/env node',
        "'use strict';",
        "const fs = require('fs');",
        'const LOG_PATH = ' + JSON.stringify(logPath) + ';',
        'const SPEC_PATH = ' + JSON.stringify(specPath) + ';',
        'const args = process.argv.slice(2);',
        'let entries = [];',
        "try { entries = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch (_) {}",
        'entries.push({ args, cwd: process.cwd(), env: {',
        "    TEST_PM2_SECRET: process.env.TEST_PM2_SECRET !== undefined ? 'set' : 'unset',",
        "    DEXBOT_CRED_BOOTSTRAP_SOCKET: process.env.DEXBOT_CRED_BOOTSTRAP_SOCKET !== undefined ? 'set' : 'unset',",
        '} });',
        'try { fs.writeFileSync(LOG_PATH, JSON.stringify(entries)); } catch (_) {}',
        "const action = String(args[0] || '');",
        "const target = String(args[1] || '');",
        'let rules = [];',
        "try { rules = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')); } catch (_) {}",
        'for (const rule of rules) {',
        '    if (rule.action !== undefined && rule.action !== action) continue;',
        '    if (rule.targetIncludes !== undefined && !target.includes(rule.targetIncludes)) continue;',
        "    if (Array.isArray(rule.stdout) && rule.stdout.length) process.stdout.write(rule.stdout.map((l) => l + '\\n').join(''));",
        "    if (Array.isArray(rule.stderr) && rule.stderr.length) process.stderr.write(rule.stderr.map((l) => l + '\\n').join(''));",
        '    process.exit(rule.code === undefined ? 0 : rule.code);',
        '}',
        'process.exit(0);',
    ];
    return lines.join('\n') + '\n';
}

function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

/**
 * Install the PATH shim. `rules` are evaluated in order per invocation; the
 * first matching rule supplies stdout/stderr/exit code. Calls are recorded to
 * a JSON file that also accepts free-form markers via appendMarker() so tests
 * can build one unified timeline of spawned commands and in-process events.
 */
function installPm2PathShim({ rules = [] } = {}) {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pm2-shim-'));
    const logPath = path.join(binDir, 'pm2-shim-calls.json');
    const specPath = path.join(binDir, 'pm2-shim-spec.json');
    const shimPath = path.join(binDir, 'pm2');

    fs.writeFileSync(specPath, JSON.stringify(rules, null, 2));
    fs.writeFileSync(shimPath, buildShimScript(logPath, specPath));
    fs.chmodSync(shimPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = binDir + path.delimiter + (originalPath || '');

    return {
        logPath,
        readCalls() {
            return readJsonFile(logPath, []);
        },
        appendMarker(label) {
            const entries = readJsonFile(logPath, []);
            entries.push({ marker: label });
            fs.writeFileSync(logPath, JSON.stringify(entries));
        },
        restore() {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            try { fs.rmSync(binDir, { recursive: true, force: true }); } catch (_) {}
        },
    };
}

module.exports = { installPm2PathShim };
