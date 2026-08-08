'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getStorage } = require('../../modules/storage');
const { ensureDir } = getStorage();

function writeFakeMemuPackage(tmpRoot) {
  const memuDir = path.join(tmpRoot, 'memu');
  ensureDir(memuDir);
  fs.writeFileSync(path.join(memuDir, '__init__.py'), `
from types import SimpleNamespace


class _FakeMemoryItemRepo:
    def __init__(self):
        self.items = {}


class _FakeResourceRepo:
    def __init__(self):
        self.resources = {}

    def list_resources(self, where=None):
        return {
            "res-1": {"id": "res-1", "where": where},
            "res-2": {"id": "res-2", "where": where},
            "res-3": {"id": "res-3", "where": where},
        }


class _FakeDatabase:
    def __init__(self):
        self.memory_item_repo = _FakeMemoryItemRepo()
        self.resource_repo = _FakeResourceRepo()


class MemoryService:
    def __init__(self, **kwargs):
        provider = kwargs.get("database_config", {}).get("metadata_store", {}).get("provider", "sqlite")
        self.database = _FakeDatabase()
        self.database_config = SimpleNamespace(metadata_store=SimpleNamespace(provider=provider))
        self.llm_profiles = SimpleNamespace(profiles={"default": object(), "embedding": object()})
        self.retrieve_config = SimpleNamespace(method="rag")
        self._context = SimpleNamespace(categories_ready=False, category_ids=[])

    async def memorize(self, *, resource_url, modality, user=None):
        return {"resource_url": resource_url, "modality": modality, "user": user}

    async def retrieve(self, queries, where=None):
        return {"queries": queries, "where": where, "method": self.retrieve_config.method}

    async def list_memory_categories(self, where=None):
        return {
            "categories": [
                {"id": "cat-1", "name": "preferences", "where": where},
                {"id": "cat-2", "name": "knowledge", "where": where},
            ]
        }

    async def list_memory_items(self, where=None):
        return {
            "items": [
                {"id": "item-1", "where": where},
                {"id": "item-2", "where": where},
            ]
        }

    async def create_memory_item(self, *, memory_type, memory_content, memory_categories, user=None):
        return {
            "memory_type": memory_type,
            "memory_content": memory_content,
            "memory_categories": memory_categories,
            "user": user,
        }

    async def update_memory_item(self, *, memory_id, memory_type=None, memory_content=None, memory_categories=None, user=None):
        return {
            "memory_id": memory_id,
            "memory_type": memory_type,
            "memory_content": memory_content,
            "memory_categories": memory_categories,
            "user": user,
        }

    async def delete_memory_item(self, *, memory_id):
        return {"deleted": True, "memory_id": memory_id}

    async def clear_memory(self, where=None):
        return {"cleared_where": where}
`);
}

function runMemuRunner(args) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-memu-test-'));
  const candidatePaths = [
    path.resolve(__dirname, '..', 'scripts', 'memu_runner.py'),
    path.resolve(__dirname, '..', '..', '..', 'claw', 'scripts', 'memu_runner.py'),
  ];
  const scriptPath = candidatePaths.find((candidate) => fs.existsSync(candidate)) || candidatePaths[0];

  try {
    writeFakeMemuPackage(tmpRoot);
    const run = spawnSync('python3', [scriptPath, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: tmpRoot
      }
    });

    return {
      code: run.status,
      stdout: run.stdout,
      stderr: run.stderr
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function parseRun(run, label) {
  assert.strictEqual(run.code, 0, `${label} failed:\nSTDERR:\n${run.stderr}\nSTDOUT:\n${run.stdout}`);
  return JSON.parse(run.stdout.trim());
}

function testCreateItemResolvesCategoryIdsAndDefaultsMemoryType() {
  const result = parseRun(runMemuRunner([
    'create-item',
    '--category-id', 'cat-1',
    '--summary', 'Prefers 2% spacing',
    '--user', '{"user_id":"trader-123"}'
  ]), 'create-item');

  assert.strictEqual(result.memory_type, 'knowledge');
  assert.deepStrictEqual(result.memory_categories, ['preferences']);
  assert.deepStrictEqual(result.user, { user_id: 'trader-123' });
}

function testUpdateItemResolvesCategoryIds() {
  const result = parseRun(runMemuRunner([
    'update-item',
    '--item-id', 'item-1',
    '--updates', '{"summary":"Updated note","memory_categories":["cat-2"],"user":{"user_id":"trader-123"}}'
  ]), 'update-item');

  assert.strictEqual(result.memory_id, 'item-1');
  assert.strictEqual(result.memory_content, 'Updated note');
  assert.deepStrictEqual(result.memory_categories, ['knowledge']);
  assert.deepStrictEqual(result.user, { user_id: 'trader-123' });
}

function testClearPassesScope() {
  const result = parseRun(runMemuRunner([
    'clear',
    '--where', '{"user_id":"trader-123"}'
  ]), 'clear');

  assert.strictEqual(result.cleared, true);
  assert.deepStrictEqual(result.cleared_where, { user_id: 'trader-123' });
}

function testStatusUsesPersistedCountsInsteadOfFreshCaches() {
  const result = parseRun(runMemuRunner([
    'status',
    '--where', '{"user_id":"trader-123"}',
    '--db-config', '{"metadata_store":{"provider":"sqlite","dsn":"sqlite:////tmp/memu-test.db"}}'
  ]), 'status');

  assert.strictEqual(result.category_count, 2);
  assert.strictEqual(result.item_count, 2);
  assert.strictEqual(result.resource_count, 3);
  assert.strictEqual(result.categories_ready, true);
  assert.strictEqual(result.metadata_store, 'sqlite');
  assert.deepStrictEqual(result.llm_profiles, ['default', 'embedding']);
}

function main() {
  testCreateItemResolvesCategoryIdsAndDefaultsMemoryType();
  testUpdateItemResolvesCategoryIds();
  testClearPassesScope();
  testStatusUsesPersistedCountsInsteadOfFreshCaches();
  console.log('memu bridge regression test passed');
}

main();
