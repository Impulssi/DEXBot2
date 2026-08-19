#!/usr/bin/env node

// MCP stdio reserves stdout for JSON-RPC frames. Some shared DEXBot2 modules
// (notably modules/paths.ts) log relocation notices during require-time
// initialization, so the heavy claw modules are loaded lazily below — AFTER the
// console shim has been installed. Static imports here are limited to the
// lightweight transport helpers (mcp_utils) which never write to stdout.

import { success, failure, runMcpServer, createMessageParser } from '../modules/mcp_utils.js';
import { pathToFileURL } from 'node:url';

console.log = () => {};
console.warn = () => {};

// NOTE: this is a custom newline-delimited JSON transport (not the official
// MCP Content-Length framing); protocolVersion is echoed from the client and
// is informational only. See claw_runtime_matrix.ts.


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

async function listMcpTools() {
  const { getClawToolCatalog } = await import('../modules/claw_catalog.js');
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
        // Echo the client's requested protocol version when provided, so a
        // JSONL-speaking client can negotiate its own version.
        protocolVersion: params?.protocolVersion || '2024-11-05',
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
      try {
        return success(id, {
          tools: await listMcpTools()
        });
      } catch (error: any) {
        return failure(id, -32602, `Failed to load tool catalog: ${error && error.message ? error.message : String(error)}`);
      }

    case 'tools/call': {
      try {
        const { getClawToolByName } = await import('../modules/claw_catalog.js');
        const tool = getClawToolByName(params?.name);
        if (!tool) {
          return failure(id, -32602, `Unknown tool: ${params?.name || '(missing)'}`);
        }

        const { runClawCommand } = await import('../modules/claw_bridge.js');
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

