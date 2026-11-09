// What an environment's Start / Apply compose passes to `env.up`, read from the
// project when the button is pressed, not from the render that drew it: in a
// server window a variables draft committed by the button's own click (the
// textarea's blur) is pending in the overlay, and the store already shows it.
//
// Pure: EnvironmentPanel supplies the store's project.
import { parseEnvVars } from '../../shared/environments.ts'
import type { EnvironmentSettings, Repository } from '../../shared/types'

export interface EnvStartArgs {
  settings: EnvironmentSettings
  /** undefined when the branch has none */
  envVars: Record<string, string> | undefined
}

/**
 * The settings `env.up` takes: the server refuses any other key (its args.ts), and a repository's
 * stored `environments` can hold others (another client's, an old file's) and `profileKey`, which
 * the server reads from its own copy of the repository.
 */
const ENV_UP_KEYS = ['enabled', 'cpu', 'memory', 'disk', 'networkAddress', 'rosetta'] as const

export function envStartArgs(repo: Repository | undefined, branch: string, composeFile: string): EnvStartArgs {
  const envVars = parseEnvVars(repo?.branchEnvVars?.[branch] ?? '')
  const stored = (repo?.environments ?? {}) as Partial<Record<string, unknown>>
  const picked = Object.fromEntries(ENV_UP_KEYS.filter((key) => stored[key] !== undefined).map((key) => [key, stored[key]]))
  return {
    settings: { enabled: true, ...picked, composeFile } as EnvironmentSettings,
    envVars: Object.keys(envVars).length > 0 ? envVars : undefined
  }
}
