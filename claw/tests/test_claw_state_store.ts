'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createStateStore } = require('../modules/claw_infra');

async function testConcurrentUpdatesPreserveBothWrites() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-state-store-'));
  const filePath = path.join(dir, 'claw-state.json');

  const firstStore = createStateStore({ filePath, defaultValue: {} });
  const secondStore = createStateStore({ filePath, defaultValue: {} });

  await Promise.all([
    firstStore.update(async (state: any) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        ...(state || {}),
        alpha: 1
      };
    }),
    secondStore.update(async (state: any) => ({
      ...(state || {}),
      beta: 1
    }))
  ]);

  const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.strictEqual(written.alpha, 1, 'first concurrent update should persist');
  assert.strictEqual(written.beta, 1, 'second concurrent update should persist');
}

async function main() {
  await testConcurrentUpdatesPreserveBothWrites();
  console.log('claw state store tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
