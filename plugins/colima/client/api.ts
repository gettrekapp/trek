// The env plugin's calls on the window's server (plugins E3; the window backend's `env` before):
// its methods by the worktree's server id and the repository's, the long ones with long timeouts.
import type { ClientPluginHost, PluginWorktree } from '../../../src/shared/plugins/client.ts'
import type { EnvCheckResult, EnvLogEvent, EnvService, EnvUpResult, EnvironmentInfo, EnvironmentSettings } from '../shared/types.ts'

/** A first boot or a compose run can take many minutes */
const LONG_MS = 30 * 60_000
/** colima stop and delete (each Ctrl-C's a running up and waits up to a minute) */
const SLOW_MS = 10 * 60_000

export interface EnvApi {
  check(): Promise<EnvCheckResult>
  list(repoId: string): Promise<EnvironmentInfo[]>
  up(worktree: PluginWorktree, settings: EnvironmentSettings, envVars: Record<string, string> | undefined): Promise<EnvUpResult>
  stop(profile: string): Promise<number>
  destroy(profile: string): Promise<number>
  ps(worktree: PluginWorktree, composeFile: string | undefined): Promise<EnvService[]>
  composeFiles(worktree: PluginWorktree): Promise<string[]>
  logs(worktree: PluginWorktree, composeFile: string | undefined, service: string, tail: number): Promise<string>
  /** The output and steps of this window's up, stop and destroy runs (env.log); returns the unsubscribe */
  onLog(listener: (event: EnvLogEvent) => void): () => void
}

export function envApi(host: ClientPluginHost): EnvApi {
  const at = (worktree: PluginWorktree) => ({ projectId: host.projectId, worktreeId: worktree.id })
  return {
    check: () => host.request<EnvCheckResult>('check', {}),
    list: (repoId) => host.request<EnvironmentInfo[]>('list', { projectId: host.projectId, repoId }),
    up: (worktree, settings, envVars) => host.request<EnvUpResult>('up', { ...at(worktree), settings, ...(envVars ? { envVars } : {}) }, { timeoutMs: LONG_MS }),
    stop: (profile) => host.request<number>('stop', { profile }, { timeoutMs: SLOW_MS }),
    destroy: (profile) => host.request<number>('destroy', { profile }, { timeoutMs: SLOW_MS }),
    ps: (worktree, composeFile) => host.request<EnvService[]>('ps', { ...at(worktree), ...(composeFile ? { composeFile } : {}) }),
    composeFiles: (worktree) => host.request<string[]>('composeFiles', at(worktree)),
    logs: (worktree, composeFile, service, tail) => host.request<string>('logs', { ...at(worktree), ...(composeFile ? { composeFile } : {}), service, tail }),
    onLog: (listener) => host.onEvent<EnvLogEvent>('log', listener)
  }
}
