// One project's trek-dev MCP with its plugins (plugin system phase 1).
import { MCP_INSTRUCTIONS, MCP_TOOLS, type ToolCall } from '../mcp/tools.ts'
import type { ToolDefinition } from '../mcp/protocol.ts'
import type { PluginRegistry } from './registry.ts'

/**
 * One project's trek-dev MCP: the core tools, then those of the plugins on in it, read at each
 * request (a plugin turned on or off shows at the agent's next tools/list).
 */
export function mcpContext(projectId: string, core: ToolCall, plugins?: PluginRegistry): { instructions: string; tools: ToolDefinition[]; call: ToolCall } {
  const own = plugins?.tools(projectId) ?? []
  if (own.length === 0 && !plugins?.instructions(projectId)) return { instructions: MCP_INSTRUCTIONS, tools: MCP_TOOLS, call: core }
  const extra = plugins?.instructions(projectId)
  return {
    instructions: extra ? `${MCP_INSTRUCTIONS} ${extra}` : MCP_INSTRUCTIONS,
    tools: [...MCP_TOOLS, ...own.map((t) => t.definition)],
    call: async (name, args, signal) => {
      const tool = own.find((t) => t.definition.name === name)
      return tool ? tool.call(args, { projectId, signal }) : core(name, args, signal)
    }
  }
}

