import { hasProcess } from '../../modules/env.js';
import { Config } from '../../modules/config.js';
import { runtime } from '../../modules/runtime.js';

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

export function createMessageParser(onMessage: any) {
  if (!hasProcess()) {
    throw new Error('MCP stdio transport not available in this environment');
  }
  const decoder = new TextDecoder('utf-8');
  let buffer: Uint8Array = new Uint8Array(0);
  let queue = Promise.resolve();

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

      queue = queue.then(() => onMessage(message)).catch((error) => {
        runtime.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      });
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
    }
  };
}

export async function runMcpServer(parseArgs: (argv: string[]) => Record<string, any>, handleRequest: (message: any, defaults: any) => Promise<void>): Promise<void> {
  if (!hasProcess()) {
    throw new Error('MCP stdio transport not available in this environment');
  }
  const defaults = parseArgs(Config.ARGS);
  const parser = createMessageParser((message: any) => handleRequest(message, defaults));
  let lastQueue = Promise.resolve();

  runtime.stdin!.on('data', (chunk) => {
    lastQueue = parser.push(chunk);
  });
  runtime.stdin!.resume();

  await new Promise<void>((resolve) => {
    runtime.stdin!.on('end', () => resolve());
  });
  await lastQueue;
}


