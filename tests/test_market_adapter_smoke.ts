const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running market_adapter smoke tests');

const { BUILD_DIR } = require('../modules/constants');
const { isDistCodeRoot } = require('../modules/launcher/runtime_entry');
// Resolve the real checkout root (works from both the source tree and the
// compiled dist/tests location) so spawned script paths stay repo-relative.
let projectRoot = path.join(__dirname, '..');
while (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    const parent = path.dirname(projectRoot);
    if (parent === projectRoot) throw new Error('Unable to locate DEXBot2 checkout root');
    projectRoot = parent;
}
const root = projectRoot;
const lockPath = path.join(root, 'market_adapter', 'state', 'market_adapter.lock');

const _isDist = isDistCodeRoot(path.dirname(__dirname));
const _adapterScript = _isDist ? `${BUILD_DIR}/market_adapter/market_adapter.js` : 'market_adapter/market_adapter.ts';
const _signalRunnerScript = _isDist ? `${BUILD_DIR}/market_adapter/ama_signal_runner.js` : 'market_adapter/ama_signal_runner.ts';

{
    if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
    }

    const res = spawnSync('node', [_adapterScript, '--once', '--dryRun', '--quiet'], {
        cwd: root,
        encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, `market_adapter --once --dryRun should exit 0, got ${res.status}\n${res.stderr || ''}`);
    assert.strictEqual(fs.existsSync(lockPath), false, 'market_adapter lock file should be released after dry run');
}

{
    const res = spawnSync('node', [_adapterScript, '--whitelist-all', '--once', '--dryRun', '--quiet'], {
        cwd: root,
        encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, `--whitelist-all should be accepted, got ${res.status}\n${res.stderr || ''}`);
}

{
    const fixture = {
        updatedAt: '2026-03-01T00:00:00.000Z',
        metrics: {
            startedAt: '2026-03-01T00:00:00.000Z',
            finishedAt: '2026-03-01T00:00:01.000Z',
            durationMs: 1000,
            totalActiveBots: 1,
            processedBots: 1,
            successBots: 1,
            failedBots: 0,
            triggeredBots: 0,
            staleBots: 0,
        },
        results: [
            {
                botName: 'XRP-BTS',
                botKey: 'xrp-bts-0',
                ok: true,
                source: 'native-incremental',
                candleCount: 123,
                amaPrice: 1281.95,
                deltaPercent: 0.42,
                thresholdPercent: 0.8,
                triggered: false,
                triggerPath: null,
                reason: null,
            },
        ],
    };

    const res = spawnSync('node', [_signalRunnerScript, '--compact'], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            AMA_SIGNAL_RUNNER_FIXTURE_JSON: JSON.stringify(fixture),
        },
    });

    assert.strictEqual(res.status, 0, `ama_signal_runner should exit 0, got ${res.status}\n${res.stderr || ''}`);

    let parsed;
    try {
        parsed = JSON.parse(String(res.stdout || '').trim());
    } catch (err) {
        throw new Error(`runner output must be valid JSON: ${getErrorMessage(err)}\nSTDOUT:\n${res.stdout}`);
    }

    assert.strictEqual(parsed.ok, true, 'runner output should include ok=true');
    assert.strictEqual(typeof parsed.updatedAt, 'string', 'runner output should include updatedAt string');
    assert.strictEqual(typeof parsed.botCount, 'number', 'runner output should include botCount number');
    assert.ok(Array.isArray(parsed.bots), 'runner output should include bots array');
    assert.strictEqual(parsed.bots.length, 1, 'runner output should include one bot from fixture');

    const b = parsed.bots[0];
    assert.strictEqual(typeof b.botName, 'string', 'botName must be string');
    assert.strictEqual(typeof b.botKey, 'string', 'botKey must be string');
    assert.strictEqual(typeof b.ok, 'boolean', 'ok must be boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(b, 'amaPrice'), 'amaPrice field must exist');
    assert.ok(Object.prototype.hasOwnProperty.call(b, 'thresholdPercent'), 'thresholdPercent field must exist');
    assert.ok(Object.prototype.hasOwnProperty.call(b, 'triggered'), 'triggered field must exist');
}

console.log('market_adapter smoke tests passed');
