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
