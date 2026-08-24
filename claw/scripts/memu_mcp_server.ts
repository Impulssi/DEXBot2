#!/usr/bin/env node

// MCP stdio reserves stdout for JSON-RPC frames. The manifest tool now builds
// the full claw catalog (via claw_manifest), so suppress incidental console
// logs the same way claw_mcp_server does.

import { createJsonRpcToolsHandler, jsonRpcError, runMcpServer } from '../modules/mcp_utils.js';
import { runMemuCommand, validateMemuCommandArgs } from '../modules/memu_bridge.js';
import { pathToFileURL } from 'node:url';
import { getErrorMessage } from '../../modules/utils/errors.js';

console.log = () => {};
console.warn = () => {};

// MCP tool name -> runMemuCommand command.
const TOOL_COMMANDS: Record<string, string> = {
  'memu_manifest': 'manifest',
  'memu_memorize': 'memorize',
  'memu_retrieve': 'retrieve',
  'memu_list_categories': 'list-categories',
  'memu_list_items': 'list-items',
  'memu_create_item': 'create-item',
  'memu_update_item': 'update-item',
  'memu_delete_item': 'delete-item',
  'memu_clear': 'clear',
  'memu_status': 'status',
  'memu_memorize_conversation': 'memorize-conversation',
  'memu_memorize_trading_context': 'memorize-trading-context',
  'memu_retrieve_trading_context': 'retrieve-trading-context'
};

/**
 * Redact a CLI argument that may carry secrets (LLM API keys, database DSNs).
 * Malformed JSON must be reported without echoing the full raw value into
 * error messages or process logs.
 */
function redactSensitiveArg(value: any) {
  const text = String(value);
  const prefixLength = 12;
  const prefix = text.slice(0, Math.min(prefixLength, text.length));
  return `${prefix}<...${text.length} chars redacted>`;
}

function parseArgs(argv: any) {
  const options: Record<string, any> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--memu-dir' && next) {
      options.memuDir = next;
      i += 1;
      continue;
    }

    if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
      continue;
    }

    if (arg === '--llm-profile' && next) {
      try {
        options.llmProfiles = JSON.parse(next);
      } catch {
        throw new Error(`Invalid JSON for --llm-profile: ${redactSensitiveArg(next)}`);
      }
      i += 1;
      continue;
    }

    if (arg === '--db-config' && next) {
      try {
        options.databaseConfig = JSON.parse(next);
      } catch {
        throw new Error(`Invalid JSON for --db-config: ${redactSensitiveArg(next)}`);
      }
      i += 1;
      continue;
    }
  }

  return options;
}

async function listMcpTools() {
  return [
    {
      name: 'memu_manifest',
      description: 'Get memU runtime manifest and capabilities',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'memu_memorize',
      description: 'Store a resource as memory. Supports conversation, document, image, video, and audio modalities.',
      inputSchema: {
        type: 'object',
        properties: {
          resourceUrl: {
            type: 'string',
            description: 'Path or URL to the resource to memorize'
          },
          modality: {
            type: 'string',
            enum: ['conversation', 'document', 'image', 'video', 'audio'],
            description: 'Type of resource content'
          },
          user: {
            type: 'object',
            description: 'Optional user scope (e.g., {user_id: "123"})'
          }
        },
        required: ['resourceUrl', 'modality'],
        additionalProperties: false
      }
    },
    {
      name: 'memu_retrieve',
      description: 'Query stored memories using RAG or LLM-based retrieval.',
      inputSchema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: {
                  type: 'object',
                  properties: { text: { type: 'string' } }
                }
              }
            },
            description: 'List of query messages'
          },
          where: {
            type: 'object',
            description: 'Optional scope filter (e.g., {user_id: "123"})'
          },
          method: {
            type: 'string',
            enum: ['rag', 'llm'],
            description: 'Retrieval method (rag for fast, llm for deep reasoning)'
          }
        },
        required: ['queries'],
        additionalProperties: false
      }
    },
    {
      name: 'memu_list_categories',
      description: 'List all memory categories',
      inputSchema: {
        type: 'object',
        properties: {
          where: {
            type: 'object',
            description: 'Optional scope filter'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'memu_list_items',
      description: 'List all memory items',
      inputSchema: {
        type: 'object',
        properties: {
          where: {
            type: 'object',
            description: 'Optional scope filter'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'memu_create_item',
      description: 'Create a memory item directly',
      inputSchema: {
        type: 'object',
        properties: {
          categoryId: { type: 'string', description: 'Category id or name to link the item to' },
          categoryName: { type: 'string', description: 'Category name alias for direct creation' },
          summary: { type: 'string', description: 'Memory content summary' },
          memoryType: {
            type: 'string',
            enum: ['profile', 'event', 'knowledge', 'behavior', 'skill', 'tool'],
            description: 'Type of memory'
          },
          user: { type: 'object', description: 'Optional user scope' }
        },
        required: ['summary'],
        anyOf: [
          { required: ['categoryId'] },
          { required: ['categoryName'] }
        ],
        additionalProperties: false
      }
    },
    {
      name: 'memu_update_item',
      description: 'Update an existing memory item',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'Item ID to update' },
          updates: { type: 'object', description: 'Fields to update on the item' }
        },
        required: ['itemId', 'updates'],
        additionalProperties: false
      }
    },
    {
      name: 'memu_delete_item',
      description: 'Delete a memory item',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'Item ID to delete' }
        },
        required: ['itemId'],
        additionalProperties: false
      }
    },
    {
      name: 'memu_clear',
      description: 'Clear all memories',
      inputSchema: {
        type: 'object',
        properties: {
          where: {
            type: 'object',
            description: 'Optional scope filter, such as {user_id: "123"}'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'memu_status',
      description: 'Get memU service status and statistics',
      inputSchema: {
        type: 'object',
        properties: {
          where: {
            type: 'object',
            description: 'Optional scope filter, such as {user_id: "123"}'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'memu_memorize_conversation',
      description: 'Memorize a conversation from message array',
      inputSchema: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: { type: 'string' }
              }
            },
            description: 'Array of conversation messages'
          },
          user: { type: 'object', description: 'Optional user scope' }
        },
        required: ['messages'],
        additionalProperties: false
      }
    },
    {
      name: 'memu_memorize_trading_context',
      description: 'Memorize trading context (bot settings, market events, positions)',
      inputSchema: {
        type: 'object',
        properties: {
          context: {
            oneOf: [
              { type: 'string' },
              { type: 'object' }
            ],
            description: 'Trading context to memorize'
          },
          user: { type: 'object', description: 'Optional user scope' }
        },
        required: ['context'],
        additionalProperties: false
      }
    },
    {
      name: 'memu_retrieve_trading_context',
      description: 'Retrieve trading-related memories',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query about trading context' },
          user: { type: 'object', description: 'Optional user scope' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  ];
}

async function callTool(params: any, defaults: any) {
  const toolName = params?.name;
  const command = TOOL_COMMANDS[toolName];
  if (!command) {
    throw jsonRpcError(-32602, `Unknown tool: ${toolName}`);
  }

  const args = params?.arguments || {};
  // Shared validation with runMemuCommand/claw_bridge so every surface rejects
  // missing args with the same message; surfaced as invalid params (-32602).
  try {
    validateMemuCommandArgs(command, { ...defaults, ...args });
  } catch (err: any) {
    throw jsonRpcError(-32602, getErrorMessage(err));
  }

  return runMemuCommand(command, { ...defaults, ...args });
}

const handleRequest = createJsonRpcToolsHandler({
  serverName: 'bitshares-memu',
  listTools: listMcpTools,
  callTool
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer(parseArgs, handleRequest).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}


