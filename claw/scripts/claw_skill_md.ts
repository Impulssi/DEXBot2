#!/usr/bin/env node

import path from 'path';
import { PATHS } from '../../modules/paths.js';
import { buildRuntimeSkillMarkdown, writeRuntimeSkillMarkdown } from '../modules/claw_skill_md.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { pathToFileURL } from 'node:url';

const CS_PROJECT_ROOT = PATHS.PROJECT_ROOT;

function parseArgs(argv: any) {
  const options: Record<string, any> = {
    outputPath: null,
    profileRoot: null,
    repoRoot: path.join(CS_PROJECT_ROOT, 'claw'),
    runtimeName: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--output' && next) {
      options.outputPath = next;
      i += 1;
      continue;
    }

    if (arg === '--repo-root' && next) {
      options.repoRoot = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--profile-root' && next) {
      options.profileRoot = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--runtime' && next) {
      options.runtimeName = next;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log([
    'Usage:',
    '  tsx scripts/claw_skill_md.ts --runtime <openclaw|hermes|openfang|nanobot|picoclaw|nanoclaw|zeroclaw|nullclaw|memu> [--repo-root PATH] [--profile-root PATH] [--output PATH]',
    '',
    'Outputs a SKILL.md file for the requested runtime.',
    'If --output is omitted, the markdown is written to stdout.'
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.runtimeName) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  if (options.outputPath) {
    await writeRuntimeSkillMarkdown(options.outputPath, options.runtimeName, {
      profileRoot: options.profileRoot,
      repoRoot: options.repoRoot
    });
    return;
  }

  process.stdout.write(`${buildRuntimeSkillMarkdown(options.runtimeName, {
    profileRoot: options.profileRoot,
    repoRoot: options.repoRoot
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : getErrorMessage(err));
    process.exit(1);
  });
}
export {};
