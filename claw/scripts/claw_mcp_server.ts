#!/usr/bin/env node

// MCP stdio reserves stdout for JSON-RPC frames. Some shared DEXBot2 modules
// log during require-time initialization, so suppress incidental console logs.

import { getClawToolByName, getClawToolCatalog } from '../modules/claw_catalog.js';
import { runClawCommand } from '../modules/claw_bridge.js';
import { success, failure, runMcpServer, createMessageParser } from '../modules/mcp_utils.js';
import { pathToFileURL } from 'node:url';
console.log = () => {};
console.warn = () => {};


function parseArgs(argv: any) {
  const options: Record<string, any> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--profile-root' && next) {
      options.profileRoot = next;
      i += 1;
      continue;
    }

    if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
      continue;
    }

    if (arg === '--runtime' && next) {
      options.runtimeName = next;
      i += 1;
      continue;
    }
  }

  return options;
}

function listMcpTools() {
  return getClawToolCatalog().map((tool: any) => ({
    name: tool.toolName,
    description: tool.description,
    inputSchema: tool.inputSchema || {
      type: 'object',
      properties: {},
      additionalProperties: true
    }
  }));
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
          name: 'bitshares-claw',
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
      const tool = getClawToolByName(params?.name);
      if (!tool) {
        return failure(id, -32602, `Unknown tool: ${params?.name || '(missing)'}`);
      }

      try {
        const result = await runClawCommand(tool.command, {
          ...defaults,
          ...(params?.arguments || {})
        });

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer(parseArgs, handleRequest).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

export { createMessageParser, failure, handleRequest, listMcpTools, success }

