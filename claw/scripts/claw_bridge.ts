#!/usr/bin/env node



import { listClawCommandNames } from '../modules/claw_catalog.js';
import { describeRuntimeManifest, runClawCommand } from '../modules/claw_bridge.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { pathToFileURL } from 'node:url';
function parseJson(value: any, fieldName: any) {
  if (value === undefined || value === null || value === '') {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${fieldName} must be a JSON object`);
  }
}

function parseArgs(argv: any) {
  const options: Record<string, any> = {
    command: null,
    payload: {}
  };

  const args = [...argv];
  // The command may appear before or after flags (e.g. `manifest --runtime openfang`
  // or `--runtime openfang manifest`). Pick the first non-flag token that is not a
  // flag value as the command.
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--payload' || arg === '--profile-root' || arg === '--account' || arg === '--bot-ref' || arg === '--pair' || arg === '--base' || arg === '--quote' || arg === '--runtime') {
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      continue;
    }
    if (!options.command) {
      options.command = arg;
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--payload' && args[i + 1]) {
      options.payload = {
        ...options.payload,
        ...parseJson(args[i + 1], '--payload')
      };
      i += 1;
      continue;
    }

    if (arg === '--profile-root' && args[i + 1]) {
      options.payload.profileRoot = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--account' && args[i + 1]) {
      options.payload.accountName = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--bot-ref' && args[i + 1]) {
      options.payload.botRef = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--pair' && args[i + 1]) {
      options.payload.pair = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--base' && args[i + 1]) {
      options.payload.baseSymbol = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--quote' && args[i + 1]) {
      options.payload.quoteSymbol = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--runtime' && args[i + 1]) {
      options.payload.runtimeName = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp(scriptPath = 'node dist/claw/scripts/claw_bridge.js') {
  const commandLines = listClawCommandNames().map((command: any) => `  ${command}`);

  console.log([
    'Usage:',
    `  ${scriptPath} <command> [--payload JSON] [options]`,
    '',
    'Commands:',
    ...commandLines
  ].join('\n'));
}

function describeScriptRuntimeManifest(runtimeName: any, payload = {}) {
  return describeRuntimeManifest(runtimeName ? { ...payload, runtimeName } : payload);
}

async function main(runtimeName = null, scriptPath = 'node dist/claw/scripts/claw_bridge.js') {
  const { command, help, payload } = parseArgs(process.argv.slice(2));

  if (help || !command) {
    printHelp(scriptPath);
    process.exit(help ? 0 : 1);
  }

  const mergedPayload = runtimeName ? { ...payload, runtimeName } : payload;
  if (command === 'manifest') {
    // main already folded runtimeName into mergedPayload; pass it straight
    // through to avoid the wrapper's redundant re-injection.
    process.stdout.write(`${JSON.stringify(describeRuntimeManifest(mergedPayload), null, 2)}\n`);
    return;
  }

  const result = await runClawCommand(command, mergedPayload);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : getErrorMessage(err));
    process.exit(1);
  });
}

export { describeScriptRuntimeManifest as describeRuntimeManifest, main }

