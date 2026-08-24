
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { PATHS } from '../../modules/paths.js';
import { runtime } from '../../modules/runtime.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { Config } from '../../modules/config.js';
import { describeClawBridge } from './claw_manifest.js';
const storage = getStorage();
const { ensureDir, unlink: safeUnlink } = storage;

let _spawn: any;
function getSpawn(): any {
    if (_spawn === undefined) {
        try {
            _spawn = require('child_process').spawn;
        } catch {
            _spawn = null;
        }
    }
    if (!_spawn) {
        throw new Error('child_process.spawn not available in this environment');
    }
    return _spawn;
}

const DEFAULT_MEMU_DIR = PATHS.CLAW.MEMU_DIR;
const DEFAULT_PYTHON = Config.MEMU_PYTHON;

// Mirror the repo version instead of hardcoding; falls back to a literal only
// if package.json is somehow unavailable.
const DEXBOT_VERSION = (() => {
  try {
    return require(path.join(PATHS.PROJECT_ROOT, 'package.json')).version;
  } catch {
    return '0.1.0';
  }
})();

function resolveMemuScript() {
  return PATHS.CLAW.MEMU_RUNNER_SCRIPT;
}

function ensureMemuDir(dir: any) {
  if (!storage.exists(dir)) {
    ensureDir(dir);
  }
  return dir;
}

function defaultDatabaseConfig(memuDir: any) {
  return {
    metadata_store: {
      provider: 'sqlite',
      dsn: `sqlite:///${path.join(memuDir, 'memu.db')}`
    }
  };
}

function normalizeScopeWhere(where = null, user = null) {
  return where || user || null;
}

function runMemuPython(args: string[], options: Record<string, any> = {}) {
  return new Promise((resolve, reject) => {
    const python = options.python || DEFAULT_PYTHON;
    const script = resolveMemuScript();
    const timeout = options.timeout || 60000;

    const child = getSpawn()(python, [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...runtime.env, ...options.env },
      cwd: options.cwd
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: any) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: any) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`memU operation timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', (code: any) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`memU Python process exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        const output = stdout.trim();
        if (!output) {
          resolve(null);
          return;
        }
        const parsed = JSON.parse(output);
        resolve(parsed);
      } catch (error: any) {
        reject(new Error(`Failed to parse memU output: ${getErrorMessage(error)}\nOutput: ${stdout.trim()}\nStderr: ${stderr.trim()}`));
      }
    });

    child.on('error', (error: any) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new Error(`Python interpreter not found: ${python}. Set MEMU_PYTHON env var or install Python 3.13+.`));
        return;
      }
      reject(error);
    });

    if (options.stdin) {
      // The child may exit before it drains stdin (bad args, crash); without
      // an 'error' listener the resulting EPIPE crashes the host process.
      child.stdin.on('error', () => {
        // Best-effort write; the close handler reports the real exit status.
      });
      child.stdin.write(JSON.stringify(options.stdin));
      child.stdin.end();
    }
  });
}

function createMemuBridge(options: Record<string, any> = {}) {
  const memuDir = ensureMemuDir(options.memuDir || DEFAULT_MEMU_DIR);
  const stateDir = ensureMemuDir(path.join(memuDir, 'state'));

  const llmProfiles = options.llmProfiles || {};
  const databaseConfig = options.databaseConfig || defaultDatabaseConfig(memuDir);

  return {
    memuDir,
    stateDir,
    llmProfiles,
    databaseConfig,

    async memorize(resourceUrl: any, modality: any, user: any = null) {
      const args = [
        'memorize',
        '--resource-url', resourceUrl,
        '--modality', modality,
        '--memu-dir', memuDir,
      ];

      if (user) {
        args.push('--user', JSON.stringify(user));
      }

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args, { timeout: options.memorizeTimeout || 120000 });
    },

    async retrieve(queries: any, where: any = null, method: any = 'rag') {
      const normalizedQueries = queries.map((q: any) => {
        if (typeof q === 'string') {
          return { role: 'user', content: { text: q } };
        }
        return q;
      });

      const args = [
        'retrieve',
        '--queries', JSON.stringify(normalizedQueries),
        '--memu-dir', memuDir,
        '--method', method
      ];

      if (where) {
        args.push('--where', JSON.stringify(where));
      }

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args, { timeout: options.retrieveTimeout || 60000 });
    },

    async listCategories(where = null) {
      const args = [
        'list-categories',
        '--memu-dir', memuDir,
      ];

      if (where) {
        args.push('--where', JSON.stringify(where));
      }

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async listItems(where = null) {
      const args = [
        'list-items',
        '--memu-dir', memuDir,
      ];

      if (where) {
        args.push('--where', JSON.stringify(where));
      }

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async createMemoryItem(categoryRef: any, summary: any, memoryType: any = 'knowledge', user: any = null) {
      const args = [
        'create-item',
        '--category-id', categoryRef,
        '--summary', summary,
        '--memory-type', memoryType,
        '--memu-dir', memuDir,
      ];

      if (user) {
        args.push('--user', JSON.stringify(user));
      }

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async updateMemoryItem(itemId: any, updates: any) {
      const args = [
        'update-item',
        '--item-id', itemId,
        '--updates', JSON.stringify(updates),
        '--memu-dir', memuDir,
      ];

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async deleteMemoryItem(itemId: any) {
      const args = [
        'delete-item',
        '--item-id', itemId,
        '--memu-dir', memuDir,
      ];

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async clearMemory(where = null) {
      const args = [
        'clear',
        '--memu-dir', memuDir,
      ];

      if (where) {
        args.push('--where', JSON.stringify(where));
      }

      if (llmProfiles.default) {
        args.push('--llm-profile', JSON.stringify(llmProfiles));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async getStatus(where = null) {
      const args = [
        'status',
        '--memu-dir', memuDir,
      ];

      if (where) {
        args.push('--where', JSON.stringify(where));
      }

      if (databaseConfig) {
        args.push('--db-config', JSON.stringify(databaseConfig));
      }

      return runMemuPython(args);
    },

    async memorizeConversation(messages: any, user: any = null) {
      const formatted = messages.map((m: any) => {
        const role = m.role || 'user';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      }).join('\n');

      const tmpDir = path.join(memuDir, 'tmp');
      if (!storage.exists(tmpDir)) {
        ensureDir(tmpDir);
      }
      const tmpFile = path.join(tmpDir, `conv_${Date.now()}.txt`);
      storage.writeFile(tmpFile, formatted);

      try {
        return await this.memorize(tmpFile, 'conversation', user);
      } finally {
        safeUnlink(tmpFile)
      }
    },

    async memorizeTradingContext(context: any, user: any = null) {
      const formatted = typeof context === 'string'
        ? context
        : JSON.stringify(context, null, 2);

      const tmpDir = path.join(memuDir, 'tmp');
      if (!storage.exists(tmpDir)) {
        ensureDir(tmpDir);
      }
      const tmpFile = path.join(tmpDir, `trading_${Date.now()}.json`);
      storage.writeFile(tmpFile, formatted);

      try {
        return await this.memorize(tmpFile, 'document', user);
      } finally {
        safeUnlink(tmpFile)
      }
    },

    async retrieveTradingContext(query: any, user: any = null) {
      const where: any = user ? { user_id: user.user_id || user } : null;
      return this.retrieve(
        [{ role: 'user', content: { text: query } }],
        where,
        'rag'
      );
    }
  };
}

function describeMemuBridge(options: Record<string, any> = {}) {
  // Merge the standard claw manifest fields so consumers get the same
  // commands/options/surfaces/tools shape as the other runtimes instead of
  // special-casing memu.
  const clawManifest = describeClawBridge(options);
  return {
    ...clawManifest,
    runtime: 'memu',
    version: DEXBOT_VERSION,
    description: 'memU proactive memory integration for DEXBot2',
    nativeIntegration: 'subprocess-bridge',
    preferredTransport: 'local-cli-json-or-mcp',
    skillFile: 'SKILL.md',
    capabilities: [
      'memorize-conversation',
      'memorize-document',
      'retrieve-memory',
      'list-categories',
      'list-items',
      'create-memory-item',
      'update-memory-item',
      'delete-memory-item',
      'clear-memory',
      'memorize-trading-context',
      'retrieve-trading-context'
    ],
    notes: 'memU provides 24/7 proactive memory for AI agents. It captures user intent, reduces LLM token costs, and enables context-aware trading assistance.',
    requirements: {
      python: '3.13+',
      package: 'memu-py',
      envVars: ['OPENAI_API_KEY', 'MEMU_PYTHON']
    }
  };
}

/**
 * Required-argument spec shared by runMemuCommand, the memU MCP server, and
 * the claw bridge's memu-* commands, so every surface rejects bad input with
 * the same message instead of maintaining three copies of the checks.
 */
const MEMU_REQUIRED_ARGS: Record<string, { groups: string[][]; message: string }> = {
  'memorize': {
    groups: [['resourceUrl'], ['modality']],
    message: 'memorize requires resourceUrl and modality'
  },
  'retrieve': {
    groups: [['queries']],
    message: 'retrieve requires queries'
  },
  'create-item': {
    groups: [['categoryId', 'categoryName', 'category'], ['summary']],
    message: 'create-item requires categoryId or categoryName, plus summary'
  },
  'update-item': {
    groups: [['itemId'], ['updates']],
    message: 'update-item requires itemId and updates'
  },
  'delete-item': {
    groups: [['itemId']],
    message: 'delete-item requires itemId'
  },
  'memorize-conversation': {
    groups: [['messages']],
    message: 'memorize-conversation requires messages array'
  },
  'memorize-trading-context': {
    groups: [['context']],
    message: 'memorize-trading-context requires context'
  },
  'retrieve-trading-context': {
    groups: [['query']],
    message: 'retrieve-trading-context requires query'
  }
};

/**
 * Throw when a memU command is missing required arguments.
 * Each group lists acceptable alternative field names; every group must be
 * satisfied by at least one present (truthy) field.
 */
function validateMemuCommandArgs(command: string, options: Record<string, any>) {
  const spec = MEMU_REQUIRED_ARGS[command];
  if (!spec) {
    return;
  }

  const satisfied = spec.groups.every(
    (group) => group.some((field) => options[field])
  );
  if (!satisfied) {
    throw new Error(spec.message);
  }
}

async function runMemuCommand(command: string, options: Record<string, any> = {}) {
  validateMemuCommandArgs(command, options);
  const bridge = createMemuBridge(options);

  switch (command) {
    case 'manifest':
      return describeMemuBridge(options);

    case 'memorize':
      return bridge.memorize(options.resourceUrl, options.modality, options.user);

    case 'retrieve':
      return bridge.retrieve(options.queries, options.where, options.method || 'rag');

    case 'list-categories':
      return bridge.listCategories(normalizeScopeWhere(options.where, options.user));

    case 'list-items':
      return bridge.listItems(normalizeScopeWhere(options.where, options.user));

    case 'create-item':
      return bridge.createMemoryItem(
        options.categoryId || options.categoryName || options.category,
        options.summary,
        options.memoryType || 'knowledge',
        options.user
      );

    case 'update-item':
      return bridge.updateMemoryItem(options.itemId, options.updates);

    case 'delete-item':
      return bridge.deleteMemoryItem(options.itemId);

    case 'clear':
      return bridge.clearMemory(normalizeScopeWhere(options.where, options.user));

    case 'status':
      return bridge.getStatus(normalizeScopeWhere(options.where, options.user));

    case 'memorize-conversation':
      return bridge.memorizeConversation(options.messages, options.user);

    case 'memorize-trading-context':
      return bridge.memorizeTradingContext(options.context, options.user);

    case 'retrieve-trading-context':
      return bridge.retrieveTradingContext(options.query, options.user);

    default:
      throw new Error(`Unsupported memU command: ${command}`);
  }
}

export { createMemuBridge, describeMemuBridge, runMemuCommand, validateMemuCommandArgs }

