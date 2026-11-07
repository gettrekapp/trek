// What Trek's MCP server asks of a window's bot: the hook's policy route, the check on every
// tools/call made with a bot turn's token, and request_approval. Pure: bot.ts passes in the runners.
import type { BotRunner } from './runner.ts'
import { TREK_TOOL_PREFIX } from './turnProcess.ts'

export interface BotMcpHandlers {
  policy: (windowId: number, hookInput: Record<string, unknown>) => object
  /** The bot's policy for a call that has reached this server. Anything but `allowed` is refused. */
  toolCall: (windowId: number, name: string, args: Record<string, unknown>) => { allowed: boolean; reason: string }
  requestApproval: (windowId: number, args: Record<string, unknown>) => string
}

type Runner = Pick<BotRunner, 'checkTool' | 'requestApproval'>

const hookAnswer = (allow: boolean, reason: string): object => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny',
    permissionDecisionReason: reason
  }
})

export function botMcpHandlers(runnerOf: (windowId: number) => Runner | undefined): BotMcpHandlers {
  return {
    // A throw reaches the 500 in startMcpServer, which blocks the tool, as does anything but allow here.
    policy: (windowId, hook) => {
      const tool = String(hook.tool_name ?? '')
      // Trek's own tools are checked once, by toolCall, when the call reaches the MCP server.
      // Checking here as well would spend an approval before the call it was for.
      if (tool.startsWith(TREK_TOOL_PREFIX)) return hookAnswer(true, 'Trek checks this call when it runs.')
      const runner = runnerOf(windowId)
      const decision = runner
        ? runner.checkTool(
            { tool, input: (hook.tool_input ?? {}) as Record<string, unknown> },
            typeof hook.cwd === 'string' ? hook.cwd : undefined
          )
        : { decision: 'deny', reason: 'The bot is not running' }
      return hookAnswer(decision.decision === 'allow', decision.reason)
    },
    toolCall: (windowId, name, args) => {
      const runner = runnerOf(windowId)
      if (!runner) return { allowed: false, reason: 'The bot is not running' }
      const decision = runner.checkTool({ tool: `${TREK_TOOL_PREFIX}${name}`, input: args })
      return { allowed: decision.decision === 'allow', reason: decision.reason }
    },
    requestApproval: (windowId, args) => {
      const runner = runnerOf(windowId)
      if (!runner) throw new Error('The bot is not running')
      if (typeof args.tool !== 'string' || typeof args.reason !== 'string' || !args.input || typeof args.input !== 'object') {
        throw new Error('tool, input and reason are required')
      }
      return runner.requestApproval(args.tool, args.input as Record<string, unknown>, args.reason)
    }
  }
}
