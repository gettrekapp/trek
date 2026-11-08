// What an environment's Start / Apply compose passes to `envUp`, read from the
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

export function envStartArgs(repo: Repository | undefined, branch: string, composeFile: string): EnvStartArgs {
  const envVars = parseEnvVars(repo?.branchEnvVars?.[branch] ?? '')
  return {
    settings: { enabled: true, ...repo?.environments, composeFile },
    envVars: Object.keys(envVars).length > 0 ? envVars : undefined
  }
}
