
import { Config } from '../../modules/config';
import { getSupportedClawRuntime, listSupportedClawRuntimes } from './claw_runtime_matrix';
import { buildClawCommandExamples, getClawToolCatalog, listClawCommandNames } from './claw_catalog.js';

function groupCommandsByRisk(tools: any[]) {
  return tools.reduce((groups: Record<string, string[]>, tool: any) => {
    const risk = tool.risk || 'read';
    if (!groups[risk]) {
      groups[risk] = [];
    }
    groups[risk].push(tool.command);
    return groups;
  }, {});
}

function describeClawBridge(options: Record<string, any> = {}) {
  const tools = getClawToolCatalog();
  const focusedRuntime = getSupportedClawRuntime(options.runtimeName || options.runtime);

  return {
    compatibility: {
      credentialBoundary: 'AI-Bot and DEXBot2 own signing and credentials',
      name: focusedRuntime?.displayName || 'Claw',
      recommendedTransport: focusedRuntime ? focusedRuntime.preferredTransport : 'runtime-specific',
      runtimes: listSupportedClawRuntimes(),
      trustModel: focusedRuntime?.trustModel || 'Claw runtimes send intents and read context; AI-Bot handles signing through DEXBot2',
      version: 2, // Incremented for credential-boundary redesign; v1 returned static surfaces only
    },
    commandExamples: buildClawCommandExamples(options.scriptPath),
    commands: listClawCommandNames(),
    options: {
      accountName: options.accountName || null,
      profileRoot: options.profileRoot || Config.DEXBOT_PROFILE_ROOT || null,
      runtimeName: focusedRuntime ? focusedRuntime.runtime : null,
      socketPath: options.socketPath || null
    },
    surfaces: {
      credentialClient: 'internal only',
      honest: 'read-only context + pair pricing',
      market: 'read-only snapshots',
      memory: 'memU proactive memory bridge',
      order: 'DEXBot2 order utilities',
      profiles: 'DEXBot2 profile-folder adapter, including bot settings read/preview/apply and read-only general.settings.json context',
      stateStore: 'filesystem-backed AI-Bot state'
    },
    tools: {
      byRisk: groupCommandsByRisk(tools),
      catalog: tools
    }
  };
}

export { describeClawBridge }

