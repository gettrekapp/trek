// What an environment's Start / Apply compose passes to `env.up`, read from the
// project when the button is pressed, not from the render that drew it: in a
// server window a variables draft committed by the button's own click (the
// textarea's blur) is pending in the overlay, and the store already shows it.
//
// Pure: EnvironmentPanel supplies the store's project.
import { ENV_DEFAULTS, parseEnvVars } from '../../shared/environments.ts'
import type { EnvLogEvent, EnvironmentSettings, Repository } from '../../shared/types'

export interface EnvStartArgs {
  settings: EnvironmentSettings
  /** undefined when the branch has none */
  envVars: Record<string, string> | undefined
}

/**
 * The settings `env.up` takes, by type: the server refuses any other key or a value of the wrong
 * type (its args.ts), and a repository's stored `environments` can hold others (another client's,
 * an old file's) and `profileKey`, which the server reads from its own copy of the repository.
 * A stored value of the wrong type is left out, so the server's default applies.
 */
const ENV_UP_FLAGS = ['enabled', 'networkAddress', 'rosetta'] as const
const ENV_UP_SIZES = ['cpu', 'memory', 'disk'] as const

/**
 * The `composeFile` argument for `env.up`, `env.ps` and `env.logs`: undefined for the default file
 * (or none), which the server then reads as the repository's, unconfined (a worktree's
 * `docker-compose.yml` may be a symlink into the main checkout, as before 5a). Only a file the user
 * chose is sent, and held to the server's inside-the-worktree check.
 */
export function composeFileArg(composeFile: string | undefined): string | undefined {
  return composeFile && composeFile !== ENV_DEFAULTS.composeFile ? composeFile : undefined
}

export function envStartArgs(repo: Repository | undefined, branch: string, composeFile: string): EnvStartArgs {
  const envVars = parseEnvVars(repo?.branchEnvVars?.[branch] ?? '')
  const stored = (repo?.environments ?? {}) as Partial<Record<string, unknown>>
  const picked: Record<string, unknown> = {}
  for (const key of ENV_UP_FLAGS) if (typeof stored[key] === 'boolean') picked[key] = stored[key]
  for (const key of ENV_UP_SIZES) if (Number.isFinite(stored[key])) picked[key] = stored[key]
  const chosen = composeFileArg(composeFile)
  return {
    settings: { enabled: true, ...picked, ...(chosen ? { composeFile: chosen } : {}) } as EnvironmentSettings,
    envVars: Object.keys(envVars).length > 0 ? envVars : undefined
  }
}

/**
 * Which `env.log` events the Env panel shows. Its profile comes from the last poll's branch, but
 * `env.up` names the VM after the branch the server finds checked out now: while a Start the panel
 * began is running (`begin` … `end`), the first step event (`vm`, which only `env.up` sends) names
 * the run's profile, and that profile's events show too.
 */
export function createRunLogFilter(): {
  begin(): void
  end(): void
  accepts(profile: string, event: Pick<EnvLogEvent, 'profile' | 'step'>): boolean
} {
  let running = false
  let runProfile: string | null = null
  return {
    begin() {
      running = true
      runProfile = null
    },
    end() {
      running = false
      runProfile = null
    },
    accepts(profile, event) {
      if (running && runProfile === null && event.step === 'vm') runProfile = event.profile
      return event.profile === profile || (running && event.profile === runProfile)
    }
  }
}
