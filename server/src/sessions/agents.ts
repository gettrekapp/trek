// What the server can launch (`server.agents`): each provider, and whether the
// program of the command the server would run for it is installed for the
// server's user. The command line itself is never sent: it may carry secrets
// (`API_KEY=… claude`).
import { commandExists } from '../../../src/host/agentService.ts'
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
export function commandBinary(command: string): string | undefined {
  return command.trim().split(/\s+/).find((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
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
 * Whether a program resolves in the login shell; each answer is shared while in
 * flight and reused for PROBE_TTL_MS. At most MAX_PROBES_IN_FLIGHT run at once.
 */
export class CommandProbe {
  private readonly exists: (binary: string) => Promise<boolean>
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; result: Promise<boolean> }>()
  private inFlight = 0

  constructor(exists: (binary: string) => Promise<boolean> = commandExists, now: () => number = Date.now) {
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
