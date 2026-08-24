import { hasProcess } from '../../modules/env.js';
import { Config } from '../../modules/config.js';
import { runtime } from '../../modules/runtime.js';

// Transport contract: this is a CUSTOM newline-delimited JSON transport, NOT
// the official LSP-style Content-Length framing from the MCP 2024-11-05 spec.
// Messages are single-line JSON-RPC 2.0 objects separated by `\n`. Clients
// that speak the official spec must be configured for this JSONL variant (see
// claw_runtime_matrix.ts). `protocolVersion` is echoed from the client and is
// only informational here.

const MAX_PENDING_MESSAGES = 256;

function writeMessage(message: any) {
  if (!hasProcess()) {
    return Promise.reject(new Error('MCP stdio transport not available in this environment'));
  }
  try {
    runtime.stdout.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function success(id: any, result: any) {
  return writeMessage({
    jsonrpc: '2.0',
    id,
    result
  });
}

export function failure(id: any, code: any, message: any, data = undefined) {
  return writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  });
}

/**
 * Build an Error that createJsonRpcToolsHandler maps to a JSON-RPC error
 * response with the given code instead of the isError:true result convention.
 * Use -32602 for caller-input problems (invalid params, unknown tool).
 */
export function jsonRpcError(code: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = code;
  return err;
}

/**
 * Shared JSON-RPC request shell for the claw/memu stdio servers: initialize
 * handshake (echoing the client's protocolVersion), notifications/initialized,
 * ping, tools/list (internal failures map to -32603), tools/call delegation,
 * and method-not-found. `callTool(params, defaults)` returns the result value
 * for a successful call; thrown Errors carrying a numeric `statusCode`
 * become JSON-RPC errors, everything else becomes an isError:true result.
 */
export function createJsonRpcToolsHandler(options: {
  serverName: string;
  serverVersion?: string;
  listTools: () => any[] | Promise<any[]>;
  callTool: (params: any, defaults: any) => Promise<any>;
}) {
  const { serverName, listTools, callTool } = options;
  const serverVersion = options.serverVersion || '0.1.0';

  return async function handleRequest(message: any, defaults: any) {
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
            name: serverName,
            version: serverVersion
          }
        });

      case 'notifications/initialized':
        return;

      case 'ping':
        return success(id, {});

      case 'tools/list':
        try {
          return success(id, {
            tools: await listTools()
          });
        } catch (error: any) {
          // Catalog load failure is a server-side problem, not bad input.
          return failure(id, -32603, `Failed to load tool catalog: ${error && error.message ? error.message : String(error)}`);
        }

      case 'tools/call': {
        try {
          const result = await callTool(params, defaults);
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
          if (error && typeof error.statusCode === 'number') {
            return failure(id, error.statusCode, error.message);
          }
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
  };
}

export function createMessageParser(onMessage: any, onDrain?: () => void) {
  if (!hasProcess()) {
    throw new Error('MCP stdio transport not available in this environment');
  }
  const decoder = new TextDecoder('utf-8');
  let buffer: Uint8Array = new Uint8Array(0);
  let queue = Promise.resolve();
  let pending = 0;

  function enqueue(handler: () => any) {
    pending += 1;
    queue = queue
      .then(handler)
      .catch((error) => {
        runtime.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0 && typeof onDrain === 'function') {
          onDrain();
        }
      });
  }

  function processBuffer() {
    while (true) {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        return;
      }

      const line = decoder.decode(buffer.slice(0, newlineIndex)).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        continue;
      }

      enqueue(() => onMessage(message));
    }
  }

  function appendUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  return {
    push(chunk: any) {
      const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(0);
      buffer = appendUint8(buffer, incoming);
      processBuffer();
      return queue;
    },
    // Number of not-yet-settled messages; the caller can pause the input stream
    // when this grows too large so memory stays bounded.
    pending() {
      return pending;
    }
  };
}

export async function runMcpServer(parseArgs: (argv: string[]) => Record<string, any>, handleRequest: (message: any, defaults: any) => Promise<void>): Promise<void> {
  if (!hasProcess()) {
    throw new Error('MCP stdio transport not available in this environment');
  }
  const defaults = parseArgs(Config.ARGS);
  let stdinPaused = false;
  const parser = createMessageParser((message: any) => handleRequest(message, defaults), () => {
    // Queue drained: resume a paused input stream so the process keeps reading.
    if (stdinPaused) {
      stdinPaused = false;
      runtime.stdin!.resume();
    }
  });
  let lastQueue = Promise.resolve();
  let finishInput: () => void = () => {};

  runtime.stdin!.on('data', (chunk) => {
    lastQueue = parser.push(chunk);
    // Backpressure: if the handler is falling behind, pause stdin until the
    // queue drains to a safe level.
    if (!stdinPaused && parser.pending() > MAX_PENDING_MESSAGES) {
      stdinPaused = true;
      runtime.stdin!.pause();
    }
  });
  // Without an 'error' listener an EPIPE/EIO on stdin emits an unhandled
  // 'error' event and crashes the MCP server mid-session. Treat it as EOF.
  runtime.stdin!.on('error', (err: any) => {
    runtime.stderr.write(`[mcp] stdin error: ${err && err.stack ? err.stack : String(err)}\n`);
    // The 'end' event never fires after a stream error; unblock the wait.
    finishInput();
  });
  runtime.stdin!.resume();

  await new Promise<void>((resolve) => {
    runtime.stdin!.on('end', () => resolve());
    finishInput = resolve;
  });
  await lastQueue;
}


