// What the server can launch (`server.agents`): each provider, and whether the
// program of the command the server would run for it is installed for the
// server's user. The command line itself is never sent: it may carry secrets
// (`API_KEY=… claude`).
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { commandExists } from '../../../src/host/agentService.ts'
import { parseWindowsCommandLine, resolveWindowsCommand } from './winLaunch.ts'
import type { ProjectSettings } from '../../../src/shared/model/types'
import { PROVIDER_LIST } from '../../../src/shared/providers/registry.ts'
import type { LlmProviderId, LlmSettings } from '../../../src/shared/providers/types'

/** How long an installed check is reused. */
export const PROBE_TTL_MS = 60_000
/** More distinct programs than this and the cache starts over. */
const MAX_PROBES = 64
/** At most this many checks run at once; a program asked for beyond that counts as not installed, uncached. */
export const MAX_PROBES_IN_FLIGHT = 8

/**
 * A command line's program: its first word after any leading NAME=value
 * assignments. A best-effort hint for the installed check, not a shell parser:
 * `env FOO=1 claude` gives `env`, and quoting or `$(...)` are not understood.
 */
export function commandBinary(command: string, platform: string = process.platform): string | undefined {
  // Windows: the first word as CreateProcess reads it ("C:\Program Files\…\claude.exe" in quotes).
  if (platform === 'win32') return parseWindowsCommandLine(command)[0] || undefined
  return command.trim().split(/\s+/).find((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** What a Windows launch runs (winSpawnPlan): anything else PATHEXT finds is refused there. */
const WINDOWS_RUNNABLE = new Set(['.exe', '.com', '.cmd', '.bat'])

/**
 * Whether `binary` is installed for the server's user: POSIX asks the login shell
 * (`command -v`); Windows resolves it as a session's launch does (resolveWindowsCommand: PATH ×
 * PATHEXT, never the current directory) and accepts only what that launch runs (.exe, .com,
 * .cmd, .bat). A relative path (`.\bin\agent`, or `\tools\x.exe`, rooted on the current drive)
 * resolves at launch against the session's worktree, which isn't known here: it can't be
 * verified, and reads as not installed. So installed means a bare name or a full path.
 * `deps`: the env and file check (default the server's own), for tests.
 */
export function platformCommandExists(
  binary: string,
  platform: string = process.platform,
  deps: { env: Record<string, string | undefined>; isFile: (path: string) => boolean } = { env: process.env, isFile }
): Promise<boolean> {
  if (platform !== 'win32') return commandExists(binary)
  const isPath = /[\\/:]/.test(binary)
  if (isPath && !/^([A-Za-z]:[\\/]|[\\/]{2})/.test(binary)) return Promise.resolve(false)
  // A full path ignores cwd; a bare name never uses it (PATH only).
  const resolved = resolveWindowsCommand(binary, { ...deps, cwd: homedir() })
  return Promise.resolve(resolved !== undefined && WINDOWS_RUNNABLE.has(win32.extname(resolved).toLowerCase()))
}

/** Each provider with the command the server runs it with, chosen as agentCommand does. */
export function agentCommands(
  llm: LlmSettings,
  settings: ProjectSettings | undefined
): { provider: LlmProviderId; label: string; command: string }[] {
  return PROVIDER_LIST.map((p) => ({
    provider: p.id,
    label: p.label,
    command:
      (p.id === 'claude' ? settings?.claudeCommand?.trim() || undefined : undefined) ??
      (llm.providers[p.id]?.command?.trim() || p.defaultCommand)
  }))
}

/**
 * Whether a program is installed (platformCommandExists by default); each answer is shared while in
 * flight and reused for PROBE_TTL_MS. At most MAX_PROBES_IN_FLIGHT run at once.
 */
export class CommandProbe {
  private readonly exists: (binary: string) => Promise<boolean>
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; result: Promise<boolean> }>()
  private inFlight = 0

  constructor(exists: (binary: string) => Promise<boolean> = platformCommandExists, now: () => number = Date.now) {
    this.exists = exists
    this.now = now
  }

  installed(binary: string): Promise<boolean> {
    const hit = this.cache.get(binary)
    if (hit && this.now() - hit.at < PROBE_TTL_MS) return hit.result
    // Too many shells already: say not installed now, and leave it uncached so the next call checks.
    if (this.inFlight >= MAX_PROBES_IN_FLIGHT) return Promise.resolve(false)
    if (this.cache.size >= MAX_PROBES) this.cache.clear()
    this.inFlight++
    const result = this.exists(binary)
      .catch(() => false)
      .finally(() => {
        this.inFlight--
      })
    this.cache.set(binary, { at: this.now(), result })
    return result
  }
}
