// Pure: the agent command line for a session, the shell that runs it, and its env.
// Mirrors the desktop's launchSpec/worktreeLaunch/globalLaunch, with app-level
// settings coming from the server config's `llm` section.
import type { ProjectSettings } from '../../../src/shared/model/types'
import { GLOBAL_SYSTEM_PROMPT, globalAgentPrompt } from '../../../src/shared/providers/prompts.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import { effectiveEffort, sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import type { LaunchSpec, LlmSelection, LlmSettings, McpAccess } from '../../../src/shared/providers/types'
import { readFileSync, statSync } from 'node:fs'
import { codedError } from '../errors.ts'
import { NO_CWD_EXE_LOOKUP } from '../../../src/host/commandPath.ts'
import { winSpawnPlan, type WinLaunchDeps } from './winLaunch.ts'

export interface AgentLaunch {
  llm: LlmSelection
  /** The id passed to the agent (preset or the discovered one to resume) */
  sessionId: string
  resume: boolean
  /** A Global panel session */
  global: boolean
  /** The session type's prompt (worktree sessions) */
  systemPrompt?: string
  /** The plugins' prompts (the voice plugin's, while it is set up); only for an agent that gets the MCP tools, which has theirs */
  pluginPrompt?: string
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
  const plugins = mcp ? launch.pluginPrompt : undefined
  // Trek's own guidance (the Global role, the plugins' prompts) first, then the user's (the session
  // type's prompt, the project's shared or Global prompt) last, so the user's can override it,
  // "do not speak summaries" included, as the desktop ordered them (worktreeLaunch/globalLaunch).
  const prompts = launch.global
    ? [mcp ? (isClaude ? GLOBAL_SYSTEM_PROMPT : globalAgentPrompt(provider.label)) : undefined, plugins, settings.globalSystemPrompt?.trim()]
    : [plugins, launch.systemPrompt?.trim(), settings.sessionSystemPrompt?.trim()]
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

/** The process a session's pty runs: `args` is an argv, or (Windows) the raw command line after `file`. */
export interface SessionProcess {
  file: string
  args: string[] | string
}

const realFiles: Pick<WinLaunchDeps, 'isFile' | 'readFile'> = {
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readFile: (path) => readFileSync(path, 'utf8')
}

/**
 * How `spec` starts in `cwd`. POSIX: its command line through the login shell (shellLaunch).
 * Windows: no shell (winLaunch.ts); a launch it refuses (not on PATH, a multi-line argument to a
 * batch file, an env prefix, too long) is a BAD_REQUEST naming why.
 */
export function sessionProcess(
  spec: LaunchSpec,
  cwd: string,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  files: Pick<WinLaunchDeps, 'isFile' | 'readFile'> = realFiles
): SessionProcess {
  if (platform !== 'win32') return shellLaunch(spec.command, platform, env)
  try {
    return winSpawnPlan(spec, { env, cwd, ...files })
  } catch (err) {
    throw codedError('BAD_REQUEST', (err as Error).message)
  }
}

/** Tells a session's agent where it runs. The provider's env cannot override the TREK_* identity. */
export function sessionEnv(
  sessionId: string,
  worktree: { id: string; path: string } | undefined,
  extra: Record<string, string> = {},
  platform: string = process.platform
): Record<string, string> {
  return {
    ...extra,
    TREK_SESSION_ID: sessionId,
    TREK_TERMINAL_ID: sessionId,
    ...(worktree ? { TREK_WORKTREE_ID: worktree.id, TREK_WORKTREE_PATH: worktree.path } : {}),
    // Windows: a session's cmd.exe (a batch-file agent, anything the agent runs through cmd)
    // never runs a program from the worktree; set last, so no provider env undoes it.
    ...(platform === 'win32' ? { [NO_CWD_EXE_LOOKUP]: '1' } : {})
  }
}
