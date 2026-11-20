// The server's integrations (phase 5b): since plugins A1b only `skills.list`, the skills the server's
// agents offer (each agent's `skills`, today only the claude plugin's). agentIntegrations makes them
// from the agent registry when the server starts (server.ts) and V2Context hands them to the
// handlers. (ElevenLabs is the voice plugin's since plugin system phase 1, Linear the Linear plugin's
// since phase 2.) Also the plugins' key slots in the secrets file and their loopback-only test
// endpoints, which the plugin registry hands each plugin's host.
import type { AgentProvider, SkillInfo } from '../../../src/shared/plugins/agents.ts'
import type { KeySlot } from '../../../src/shared/plugins/server.ts'
import type { SecretFile } from '../secrets.ts'

export interface Integrations {
  /** A worktree's skills and commands, then the server user's */
  skills: { list(worktreePath: string): Promise<SkillInfo[]> }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * A test endpoint from the environment (`name`, for the smokes' stubs): taken only as an http(s)
 * URL on loopback, so an inherited variable can never send the server's keys elsewhere; anything
 * else is ignored with a warning (the real service is used). Returns the URL as parsed (the one
 * that was checked), not the string as given.
 */
export function testEndpoint(name: string, value: string | undefined, warn: (message: string) => void = console.warn): string | undefined {
  if (!value) return undefined
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }
  if (url && (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password) return url.href
  warn(`[integrations] ignoring ${name}: only an http(s) URL on 127.0.0.1, ::1 or localhost is accepted`)
  return undefined
}

export function keySlot(file: SecretFile, name: string): KeySlot {
  return {
    get: () => file.get(name),
    set: (value) => file.set(name, value),
    setIfAbsent: (value) => file.setIfAbsent(name, value)
  }
}

/** The skills the server's agents offer (plugins A1b: the claude plugin's), as `skills.list` answers them: in the agents' order, the first of a name kept. */
export function agentIntegrations(agents: { all(): readonly Pick<AgentProvider, 'skills'>[] }): Integrations {
  return {
    skills: {
      list: async (worktreePath) => {
        const lists = await Promise.all(agents.all().map((a) => a.skills?.(worktreePath) ?? Promise.resolve([])))
        const byName = new Map<string, SkillInfo>()
        for (const skill of lists.flat()) if (!byName.has(skill.name)) byName.set(skill.name, skill)
        return [...byName.values()]
      }
    }
  }
}
