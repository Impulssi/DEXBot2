
import { path } from '../../modules/path_api';
import { getStorage } from '../../modules/storage';
import { PATHS } from '../../modules/paths';
import { runtime } from '../../modules/runtime';
import { ensureDir, safeUnlink } from '../../modules/utils/fs_utils';
import { Config } from '../../modules/config';
const storage = getStorage();

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

function resolveMemuScript() {
  const candidates = [
    PATHS.CLAW.MEMU_RUNNER_SCRIPT,
  ];

  for (const candidate of candidates) {
    if (storage.exists(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
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
        reject(new Error(`Failed to parse memU output: ${error.message}\nOutput: ${stdout.trim()}\nStderr: ${stderr.trim()}`));
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
  return {
    runtime: 'memu',
    version: '0.1.0',
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

async function runMemuCommand(command: string, options: Record<string, any> = {}) {
  const bridge = createMemuBridge(options);

  switch (command) {
    case 'manifest':
      return describeMemuBridge(options);

    case 'memorize': {
      if (!options.resourceUrl || !options.modality) {
        throw new Error('memorize requires resourceUrl and modality');
      }
      return bridge.memorize(options.resourceUrl, options.modality, options.user);
    }

    case 'retrieve': {
      if (!options.queries) {
        throw new Error('retrieve requires queries');
      }
      return bridge.retrieve(options.queries, options.where, options.method || 'rag');
    }

    case 'list-categories':
      return bridge.listCategories(normalizeScopeWhere(options.where, options.user));

    case 'list-items':
      return bridge.listItems(normalizeScopeWhere(options.where, options.user));

    case 'create-item': {
      const categoryRef = options.categoryId || options.categoryName || options.category;
      if (!categoryRef || !options.summary) {
        throw new Error('create-item requires categoryId or categoryName, plus summary');
      }
      return bridge.createMemoryItem(
        categoryRef,
        options.summary,
        options.memoryType || 'knowledge',
        options.user
      );
    }

    case 'update-item': {
      if (!options.itemId || !options.updates) {
        throw new Error('update-item requires itemId and updates');
      }
      return bridge.updateMemoryItem(options.itemId, options.updates);
    }

    case 'delete-item': {
      if (!options.itemId) {
        throw new Error('delete-item requires itemId');
      }
      return bridge.deleteMemoryItem(options.itemId);
    }

    case 'clear':
      return bridge.clearMemory(normalizeScopeWhere(options.where, options.user));

    case 'status':
      return bridge.getStatus(normalizeScopeWhere(options.where, options.user));

    case 'memorize-conversation': {
      if (!options.messages) {
        throw new Error('memorize-conversation requires messages array');
      }
      return bridge.memorizeConversation(options.messages, options.user);
    }

    case 'memorize-trading-context': {
      if (!options.context) {
        throw new Error('memorize-trading-context requires context');
      }
      return bridge.memorizeTradingContext(options.context, options.user);
    }

    case 'retrieve-trading-context': {
      if (!options.query) {
        throw new Error('retrieve-trading-context requires query');
      }
      return bridge.retrieveTradingContext(options.query, options.user);
    }

    default:
      throw new Error(`Unsupported memU command: ${command}`);
  }
}

export { createMemuBridge, describeMemuBridge, runMemuCommand, resolveMemuScript, DEFAULT_MEMU_DIR }

