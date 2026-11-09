// Shared by renderer, main, and (later) the daemon — keep dependency-free
// (no node:crypto) so it stays renderer-safe.

export const ENV_PROFILE_PREFIX = 'twb-'

/** djb2 — stability matters more than distribution here. */
function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * Colima profile name for a branch's environment. Branch-keyed (like
 * branchTags) so it survives the worktree being deleted and re-created; the
 * hash disambiguates same-named branches across repos and truncated slugs.
 */
export function deriveProfileName(repoPath: string, branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '')
  return `${ENV_PROFILE_PREFIX}${slug || 'env'}-${hash(`${repoPath}\0${branch}`)}`
}

/**
 * The repository path a branch's VM name hashes: the repository's own, or the
 * `profileKey` an import kept. An imported repository is stored at its realpath
 * (`server.addRepo`), but its file window named VMs after the path the file had,
 * so the import keeps that path here and the existing VMs stay this repository's.
 */
export function envRepoKey(repo: { path: string; environments?: { profileKey?: unknown } }): string {
  // Stored data a client or file could have written anything into: only an absolute path counts.
  const key = repo.environments?.profileKey
  return typeof key === 'string' && key.startsWith('/') ? key : repo.path
}

/** Colima registers a docker context named after the profile. */
export const dockerContextFor = (profile: string): string => `colima-${profile}`

/**
 * Parse .env-style text ("KEY=value" per line) into a map. Blank lines and
 * lines that aren't KEY= assignments (e.g. # comments) are skipped; matching
 * surrounding quotes are stripped from values.
 */
export function parseEnvVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted) value = quoted[2]
    vars[m[1]] = value
  }
  return vars
}

export const ENV_DEFAULTS = {
  cpu: 2,
  memory: 4,
  disk: 20,
  networkAddress: true,
  rosetta: false,
  composeFile: 'docker-compose.yml'
} as const

const REGISTRY_UNREADABLE = 'The environments registry '

/** The server's env.list (and every change) refuses an unreadable registry with this message, naming the file. */
export function registryUnreadableMessage(registryFile: string, reason: string): string {
  return `${REGISTRY_UNREADABLE}${registryFile} cannot be read (${reason}); it was left as it is`
}

/**
 * What an env.list failure should show: the server's TOOL_ERROR for a registry it cannot read (it
 * stays until someone fixes the file), or null for the rest (a colima hiccup, a dropped link), which
 * the poll keeps quiet and retries.
 */
export function envListProblem(err: unknown): string | null {
  const e = err as { code?: unknown; message?: unknown } | null | undefined
  if (e?.code !== 'TOOL_ERROR' || typeof e.message !== 'string') return null
  return e.message.startsWith(REGISTRY_UNREADABLE) ? e.message : null
}
