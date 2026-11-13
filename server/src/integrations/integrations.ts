// The server's integrations (phase 5b): Linear with the server's own key in its secrets file, and
// the Claude Code skills on its disk. Made once per server (index.ts) and handed to the handlers
// through V2Context. (ElevenLabs is the voice plugin's since plugin system phase 1.)
import { createLinearService, type KeySlot, type LinearService } from '../../../src/host/linearService.ts'
import { listSkills } from '../../../src/host/skillService.ts'
import type { SkillInfo } from '../../../src/shared/types'
import { createSecretFile, type SecretFile } from '../secrets.ts'

/** The secrets file's names. */
export const LINEAR_SECRET = 'linear'

export interface Integrations {
  linear: LinearService
  /** A worktree's skills and commands, then the server user's */
  skills: { list(worktreePath: string): Promise<SkillInfo[]> }
}

export interface IntegrationOptions {
  /** `secrets.json` beside the server's config (secretsPathFor) */
  secretsFile: string
  /**
   * Linear's GraphQL endpoint, for tests (default api.linear.app); the server reads
   * `TREK_SERVER_LINEAR_URL` from its environment for its smokes (loopback only: testEndpoint).
   */
  linearEndpoint?: string
  /** Whose `~/.claude` the skills come from (default: the server user's home) */
  home?: string
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

export function createIntegrations(options: IntegrationOptions): Integrations {
  const secrets = createSecretFile(options.secretsFile)
  return {
    linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint }),
    skills: { list: (worktreePath) => listSkills(worktreePath, options.home) }
  }
}
