'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
const watcherModulePath = require.resolve('../modules/position_manager_watch');
const positionManagerPath = require.resolve('../modules/position_manager');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');

function loadWatcherModule(mockPositionManager: any, waitForConnected: any) {
  delete require.cache[watcherModulePath];
  delete require.cache[positionManagerPath];
  delete require.cache[bitsharesClientPath];

  Module._load = function(request: any, parent: any, isMain: any) {
    if (['./position_manager', './position_manager.js'].includes(request) && parent?.filename === watcherModulePath) {
      return {
        DEFAULT_STATE_PATH: path.join(os.tmpdir(), 'unused-positions.json'),
        PositionManager: mockPositionManager
      };
    }
    if (['./bitshares_client', './bitshares_client.js'].includes(request) && parent?.filename === watcherModulePath) {
      return {
        waitForConnected
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../modules/position_manager_watch');
  } finally {
    Module._load = originalLoad;
  }
}

async function testHealthWritesStayOrdered() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-watch-'));
  const healthPath = path.join(tmpDir, 'watcher-health.json');

  let syncCount = 0;
  class MockPositionManager {
    [key: string]: any;
    constructor() {}

    async syncAllPositions() {
      syncCount += 1;
      if (syncCount === 1) {
        return { ok: true };
      }
      if (syncCount === 2) {
        throw new Error('timer failure');
      }
      return { ok: true };
    }

    async watchAccount() {
      return async () => {};
    }
  }

  const { createPositionManagerWatcher } = loadWatcherModule(MockPositionManager, async () => {});

  try {
    const watcher = createPositionManagerWatcher({
      accountName: 'tester',
      healthPath,
      maxConsecutiveFailures: 1,
      logger: {
        error: () => {},
        info: () => {},
        warn: () => {}
      },
      syncIntervalMs: 20
    });

    const started = await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await started.stop();

    const health = JSON.parse(await fs.readFile(healthPath, 'utf8'));
    assert.strictEqual(health.status, 'healthy', 'latest health write should win');
    assert.strictEqual(health.consecutiveFailures, 0, 'health should reset after a later success');
    assert.ok(syncCount >= 3, 'test should exercise the initial sync plus failure and recovery');
  } finally {
    delete require.cache[watcherModulePath];
    delete require.cache[positionManagerPath];
    delete require.cache[bitsharesClientPath];
  }
}

async function main() {
  await testHealthWritesStayOrdered();
  console.log('position manager watcher health tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
