import { path } from '../../modules/path_api.js';
import { PATHS } from '../../modules/paths.js';
const { version: DEXBOT_VERSION } = require(path.join(PATHS.PROJECT_ROOT, 'package.json'));

export function normalizeRepoRoot(variableName: string, repoRoot?: string) {
  return path.resolve(repoRoot || PATHS.CLAW.DIR);
}

export function normalizeProfileRoot(options: Record<string, any> = {}, repoRoot: string) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }

  if (options.dexbotRoot) {
    return path.resolve(options.dexbotRoot);
  }

  return path.resolve(repoRoot, '..');
}

export function shellQuote(value: any) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function buildBridgeCommand(bridgeScript: string, profileRoot: string, command: string, extraArgs: any[] = []) {
  return ['node', bridgeScript, command, '--profile-root', profileRoot, ...extraArgs]
    .map((part, index) => (index === 0 ? String(part) : shellQuote(part)))
    .join(' ');
}

export function createTool(name: string, description: string, command: string, args: any = null) {
  return {
    name,
    description,
    kind: 'shell',
    command,
    ...(args ? { args } : {})
  };
}

export function tomlString(value: any) {
  return JSON.stringify(String(value));
}

export function buildSkillTomlLines(skillName: string, description: string, tags: string[], tools: any[]) {
  const lines = [
    '[skill]',
    `name = "${skillName}"`,
    `description = "${description}"`,
    `version = "${DEXBOT_VERSION}"`,
    `tags = [${tags.map(t => JSON.stringify(t)).join(', ')}]`
  ];

  for (const tool of tools) {
    lines.push('', '[[tools]]');
    lines.push(`name = ${tomlString(tool.name)}`);
    lines.push(`description = ${tomlString(tool.description)}`);
    lines.push(`kind = ${tomlString(tool.kind)}`);
    lines.push(`command = ${tomlString(tool.command)}`);

    if (tool.args && Object.keys(tool.args).length > 0) {
      const argEntries = Object.entries(tool.args)
        .map(([key, value]) => `${key} = ${tomlString(value)}`)
        .join(', ');
      lines.push(`args = { ${argEntries} }`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
