// Pure: the agent command line for a session, the shell that runs it, and its env.
// Mirrors the desktop's launchSpec/worktreeLaunch/globalLaunch, with app-level
// settings coming from the server config's `llm` section.
import type { ProjectSettings } from '../../../src/shared/model/types'
import { GLOBAL_SYSTEM_PROMPT, globalAgentPrompt } from '../../../src/shared/providers/prompts.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import { effectiveEffort, sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import type { LaunchSpec, LlmSelection, LlmSettings, McpAccess } from '../../../src/shared/providers/types'

export interface AgentLaunch {
  llm: LlmSelection
  /** The id passed to the agent (preset or the discovered one to resume) */
  sessionId: string
  resume: boolean
  /** A Global panel session */
  global: boolean
  /** The session type's prompt (worktree sessions) */
  systemPrompt?: string
  /** Sent only on a fresh start */
  initialMessage?: string
  addDirs?: string[]
  /** Phase 2e: the server's MCP endpoint */
  mcp?: McpAccess
}

export function agentCommand(launch: AgentLaunch, settings: ProjectSettings, llm: LlmSettings): LaunchSpec {
  const selection = sanitizeLlmSelection(launch.llm) ?? { provider: 'claude' }
  const provider = getProvider(selection.provider)
  const config = llm.providers[provider.id] ?? {}
  const isClaude = provider.id === 'claude'
  const mcp = launch.mcp && provider.capabilities.mcp ? launch.mcp : undefined
  const prompts = launch.global
    ? [mcp ? (isClaude ? GLOBAL_SYSTEM_PROMPT : globalAgentPrompt(provider.label)) : undefined, settings.globalSystemPrompt?.trim()]
    : [launch.systemPrompt?.trim(), settings.sessionSystemPrompt?.trim()]
  const systemPrompt = prompts.filter(Boolean).join('\n\n') || undefined
  return provider.buildLaunch({
    sessionId: launch.sessionId,
    resume: launch.resume,
    model: selection.model,
    effort: effectiveEffort(selection),
    approvalMode:
      (isClaude ? settings.claudePermissionMode?.trim() : undefined) ||
      config.approvalMode?.trim() ||
      provider.defaultApprovalMode,
    command: (isClaude ? settings.claudeCommand?.trim() || undefined : undefined) ?? (config.command?.trim() || undefined),
    extraArgs: isClaude ? settings.claudeArgs?.trim() || undefined : undefined,
    mcp,
    systemPrompt,
    initialMessage: launch.resume ? undefined : launch.initialMessage,
    addDirs: provider.capabilities.addDirs ? launch.addDirs : undefined,
    localBackend: llm.providers.local?.backend,
    baseUrl: llm.providers.local?.baseUrl
  })
}

/**
 * The process that runs `command`: a login shell with `-c`, so the pty ends when
 * the agent does and carries its exit status. Not `exec <command>`: that breaks
 * env-prefixed (`VAR=x claude`) and compound commands, and skips aliases, all of
 * which work when the desktop types the command into a shell.
 */
export function shellLaunch(
  command: string,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  return { file: env.SHELL || '/bin/sh', args: ['-ilc', command] }
}

/** Tells a session's agent where it runs. The provider's env cannot override the TREK_* identity. */
export function sessionEnv(
  sessionId: string,
  worktree: { id: string; path: string } | undefined,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...extra,
    TREK_SESSION_ID: sessionId,
    TREK_TERMINAL_ID: sessionId,
    ...(worktree ? { TREK_WORKTREE_ID: worktree.id, TREK_WORKTREE_PATH: worktree.path } : {})
  }
}
