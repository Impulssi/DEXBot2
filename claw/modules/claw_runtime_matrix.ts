const SUPPORTED_CLAW_RUNTIMES = Object.freeze([
  {
    runtime: 'openclaw',
    displayName: 'OpenClaw',
    nativeIntegration: 'plugin',
    preferredTransport: 'plugin-or-mcp',
    skillFile: 'SKILL.md',
    notes: 'Native plugin registration is preferred; SKILL.md remains the native workflow layer.',
    trustModel: 'OpenClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'hermes',
    displayName: 'Hermes',
    nativeIntegration: 'mcp-plus-skill-md',
    preferredTransport: 'mcp-stdio-jsonl',
    skillFile: 'SKILL.md',
    notes: 'Hermes prefers the shared MCP server via ~/.hermes/config.yaml, with an optional SKILL.md in ~/.hermes/skills for workflow guidance.',
    trustModel: 'Hermes consumes Claw through the shared MCP server and optional skill guidance; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'openfang',
    displayName: 'OpenFang',
    nativeIntegration: 'skill-md',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.md',
    notes: 'OpenFang can load prompt-only SKILL.md skills and shell out to the shared CLI bridge from a local workspace skill.',
    trustModel: 'OpenFang sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'nanobot',
    displayName: 'NanoBot',
    nativeIntegration: 'mcp',
    preferredTransport: 'mcp-stdio-jsonl',
    skillFile: 'SKILL.md',
    notes: 'Native external tool surface is MCP over stdio with newline-delimited JSON-RPC, with SKILL.md used for workflow guidance.',
    trustModel: 'NanoBot sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'picoclaw',
    displayName: 'PicoClaw',
    nativeIntegration: 'mcp',
    preferredTransport: 'mcp-stdio-jsonl',
    skillFile: 'SKILL.md',
    notes: 'PicoClaw mirrors NanoBot on native SKILL.md loading and MCP stdio integration with newline-delimited JSON-RPC.',
    trustModel: 'PicoClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'nanoclaw',
    displayName: 'NanoClaw',
    nativeIntegration: 'skill-md',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.md',
    notes: 'NanoClaw uses Claude Code skill files with a local JSON CLI bridge and workspace-level skill loading.',
    trustModel: 'NanoClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'zeroclaw',
    displayName: 'ZeroClaw',
    nativeIntegration: 'skill-manifest',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.toml',
    notes: 'Native shell-tool manifests with prompts and tool declarations.',
    trustModel: 'ZeroClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'nullclaw',
    displayName: 'NullClaw',
    nativeIntegration: 'skill-manifest',
    preferredTransport: 'skill-toml-or-mcp',
    skillFile: 'SKILL.toml',
    notes: 'NullClaw prefers SKILL.toml in ~/.nullclaw/workspace/skills and can also load Claw through mcp_servers.',
    trustModel: 'NullClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
  },
  {
    runtime: 'memu',
    displayName: 'memU',
    nativeIntegration: 'subprocess-bridge',
    preferredTransport: 'local-cli-json-or-mcp',
    skillFile: 'SKILL.md',
    notes: 'memU provides 24/7 proactive memory for AI agents. Uses Python subprocess bridge with MCP stdio support for memory operations.',
    trustModel: 'memU sends intents and reads context; AI-Bot handles signing through DEXBot2'
  }
]);

function cloneRuntime(runtime: any) {
  return { ...runtime };
}

function listSupportedClawRuntimes() {
  return SUPPORTED_CLAW_RUNTIMES.map(cloneRuntime);
}

function getSupportedClawRuntime(runtimeName: string) {
  if (!runtimeName) {
    return null;
  }

  const normalized = String(runtimeName).trim().toLowerCase();
  const match = SUPPORTED_CLAW_RUNTIMES.find((runtime) => runtime.runtime === normalized);
  return match ? cloneRuntime(match) : null;
}

export { getSupportedClawRuntime, listSupportedClawRuntimes }

