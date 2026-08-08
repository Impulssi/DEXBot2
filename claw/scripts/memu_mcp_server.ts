#!/usr/bin/env node



import { createMemuBridge, describeMemuBridge } from '../modules/memu_bridge.js';
import { success, failure, runMcpServer, createMessageParser } from '../modules/mcp_utils.js';
import { runMemuCommand } from '../modules/memu_bridge.js';
import { pathToFileURL } from 'node:url';
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
      } catch (e) {
        throw new Error(`Invalid JSON for --llm-profile: ${next}`);
      }
      i += 1;
      continue;
    }

    if (arg === '--db-config' && next) {
      options.databaseConfig = JSON.parse(next);
      i += 1;
      continue;
    }
  }

  return options;
}

function listMcpTools() {
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

async function handleRequest(message: any, defaults: any) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return success(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'bitshares-memu',
          version: '0.1.0'
        }
      });

    case 'notifications/initialized':
      return;

    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, {
        tools: listMcpTools()
      });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      try {
        let result;

        switch (toolName) {
          case 'memu_manifest':
            result = describeMemuBridge(defaults);
            break;

          case 'memu_memorize':
            if (!args.resourceUrl || !args.modality) {
              return failure(id, -32602, 'memu_memorize requires resourceUrl and modality');
            }
            result = await runMemuTool('memorize', args, defaults);
            break;

          case 'memu_retrieve':
            if (!args.queries) {
              return failure(id, -32602, 'memu_retrieve requires queries');
            }
            result = await runMemuTool('retrieve', args, defaults);
            break;

          case 'memu_list_categories':
            result = await runMemuTool('list-categories', args, defaults);
            break;

          case 'memu_list_items':
            result = await runMemuTool('list-items', args, defaults);
            break;

          case 'memu_create_item':
            if (!(args.categoryId || args.categoryName) || !args.summary) {
              return failure(id, -32602, 'memu_create_item requires categoryId or categoryName, plus summary');
            }
            result = await runMemuTool('create-item', args, defaults);
            break;

          case 'memu_update_item':
            if (!args.itemId || !args.updates) {
              return failure(id, -32602, 'memu_update_item requires itemId and updates');
            }
            result = await runMemuTool('update-item', args, defaults);
            break;

          case 'memu_delete_item':
            if (!args.itemId) {
              return failure(id, -32602, 'memu_delete_item requires itemId');
            }
            result = await runMemuTool('delete-item', args, defaults);
            break;

          case 'memu_clear':
            result = await runMemuTool('clear', args, defaults);
            break;

          case 'memu_status':
            result = await runMemuTool('status', args, defaults);
            break;

          case 'memu_memorize_conversation':
            if (!args.messages) {
              return failure(id, -32602, 'memu_memorize_conversation requires messages');
            }
            result = await runMemuTool('memorize-conversation', args, defaults);
            break;

          case 'memu_memorize_trading_context':
            if (!args.context) {
              return failure(id, -32602, 'memu_memorize_trading_context requires context');
            }
            result = await runMemuTool('memorize-trading-context', args, defaults);
            break;

          case 'memu_retrieve_trading_context':
            if (!args.query) {
              return failure(id, -32602, 'memu_retrieve_trading_context requires query');
            }
            result = await runMemuTool('retrieve-trading-context', args, defaults);
            break;

          default:
            return failure(id, -32602, `Unknown tool: ${toolName}`);
        }

        return success(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        });
      } catch (error: any) {
        return success(id, {
          content: [
            {
              type: 'text',
              text: error && error.stack ? error.stack : String(error)
            }
          ],
          isError: true
        });
      }
    }

    default:
      if (id !== undefined) {
        return failure(id, -32601, `Method not found: ${method}`);
      }
  }
}

async function runMemuTool(command: any, args: any, defaults: any) {
  return runMemuCommand(command, { ...defaults, ...args });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer(parseArgs, handleRequest).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

export { createMessageParser, failure, handleRequest, listMcpTools, success }

