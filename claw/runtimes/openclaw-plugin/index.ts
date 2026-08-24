

import definePluginEntry from 'openclaw/plugin-sdk/plugin-entry';
import { getClawToolCatalog } from '../../modules/claw_catalog.js';
import { runClawCommand } from '../../modules/claw_bridge.js';
import { getErrorMessage } from '../../../modules/utils/errors.js';

function formatResult(result: any) {
  return JSON.stringify(result, null, 2);
}

const plugin = definePluginEntry({
  id: "bitshares-claw",
  name: "BitShares Claw",
  description: "Native BitShares tools from DEXBot2/claw",
  register(api: any) {
    for (const tool of getClawToolCatalog().filter((entry: any) => entry.runtimes.includes("openclaw"))) {
      api.registerTool({
        name: tool.toolName,
        description: `[${tool.risk}] ${tool.description}`,
        parameters: tool.inputSchema,
        async execute(_id: any, params: any) {
          // Match the MCP servers' convention: tool failures surface as an
          // isError result instead of a raw rejected promise.
          try {
            const result = await runClawCommand(tool.command, { ...params, runtimeName: 'openclaw' });
            return {
              content: [
                {
                  type: "text",
                  text: formatResult(result)
                }
              ],
              structuredContent: result
            };
          } catch (error: any) {
            const text = error && error.stack ? error.stack : getErrorMessage(error);
            return {
              content: [
                {
                  type: "text",
                  text
                }
              ],
              isError: true
            };
          }
        }
      });
    }
  }
});

export default plugin

