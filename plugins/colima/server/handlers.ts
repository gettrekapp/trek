// The Colima plugin's methods (plugins E2): env.check, env.list, env.up, env.stop, env.destroy,
// env.ps, env.composeFiles and env.logs, with the names, payloads and answers they had in core
// (server/src/integrations/machineHandlers.ts before E2). Every path comes from the server's own
// state through the host's checked lookups (a repository or worktree id, never a client path), and
// every other argument is checked (args.ts) before it reaches a command line. env.up, env.stop and
// env.destroy stream their output to the asking connection as env.log.
import { pluginError, type PluginCallContext, type PluginHandler, type PluginWorktree, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { REGISTRY_REASON, deriveProfileName, repoKeyFor } from '../shared/environments.ts'
import type { EnvLogEvent } from '../shared/types.ts'
import { optionalComposeFile, optionalEnvVars, optionalInt, requireEnvSettings, requireProfile, requireService } from './args.ts'
import type { EnvironmentService } from './service.ts'

const MAX_MESSAGE = 4000
export const OFF_MESSAGE = 'Colima environments are turned off for this project'
const bad = (message: string): Error => pluginError('BAD_REQUEST', message)

/** The repository's VM key: the profileKey an import kept (its repo setting), else its path. */
export function repoKeyOf(host: Pick<ServerPluginHost, 'repoSettings'>, projectId: string, repo: { id: string; path: string }): string {
  return repoKeyFor(repo.path, host.repoSettings(projectId, repo.id).profileKey)
}

/** The worktree's branch's VM profile; null when it is detached. */
export function profileOf(host: Pick<ServerPluginHost, 'repoSettings'>, projectId: string, worktree: PluginWorktree): string | null {
  return worktree.branch ? deriveProfileName(repoKeyOf(host, projectId, { id: worktree.repoId, path: worktree.repoPath }), worktree.branch) : null
}

/**
 * A tool's failure as core answered it: TOOL_ERROR, with `reason: 'missing'` when the program is
 * not installed (the host's ENOENT, which has no syscall: a file's ENOENT is an ordinary failure)
 * and `reason: 'registry'` when the registry cannot be read. A BAD_REQUEST stays one.
 */
export async function viaTool<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    const e = err as { code?: unknown; syscall?: unknown; reason?: unknown } | null
    if (e?.code === 'BAD_REQUEST') throw err
    const message = err instanceof Error ? err.message : String(err)
    if (e?.code === 'ENOENT' && e.syscall === undefined) throw pluginError('TOOL_ERROR', `${message} (it is not on the server's PATH)`, { reason: 'missing' })
    throw pluginError('TOOL_ERROR', message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message, e?.reason === REGISTRY_REASON ? { reason: REGISTRY_REASON } : undefined)
  }
}

export function colimaHandlers(host: ServerPluginHost, env: EnvironmentService): Record<string, PluginHandler> {
  const logTo =
    (ctx: PluginCallContext) =>
    (event: EnvLogEvent): void =>
      host.emitTo(ctx.caller, 'env.log', event)

  /** The worktree's branch's environment (core's environmentOf): a present worktree on a branch. */
  const environmentOf = async (p: Record<string, unknown>): Promise<{ worktree: PluginWorktree; profile: string }> => {
    const worktree = await host.checkedWorktree(p.projectId, p.worktreeId)
    const profile = profileOf(host, p.projectId as string, worktree)
    if (!profile) throw bad(`${worktree.path} has no branch checked out (detached HEAD)`)
    return { worktree, profile }
  }

  /**
   * CONFLICT while the server tears down or holds a worktree whose branch's VM is `profile`
   * (plugins E1): an older client's own teardown (env.destroy) must not run during the server's.
   * The lifecycle's own teardown deletes the VM through the service, not this.
   */
  const assertProfileFree = (profile: string): void => {
    for (const busy of host.busyWorktrees()) {
      if (profileOf(host, busy.projectId, busy.worktree) === profile) throw pluginError('CONFLICT', busy.reason)
    }
  }

  return {
    check: () => env.check(),

    list: (p) => {
      const repo = host.checkedRepo(p.projectId, p.repoId)
      return viaTool(() => env.list(repoKeyOf(host, p.projectId as string, repo)))
    },

    // The branch git has checked out now (re-read), the repository's VM key from the server's own
    // data (never the client's profileKey), the settings and variables checked.
    // Not where the plugin is off for the project: a teardown skips an off plugin, so a VM made
    // there could never be cleaned up with its worktree. The other methods still answer, so a VM
    // made before it was turned off can be seen, stopped and destroyed.
    up: async (p, ctx) => {
      const worktree = await host.checkedWorktree(p.projectId, p.worktreeId, { refresh: true })
      if (!host.isEnabled(p.projectId as string)) throw bad(OFF_MESSAGE)
      const settings = requireEnvSettings(p.settings, worktree.path)
      const envVars = optionalEnvVars(p.envVars)
      const repoKey = repoKeyOf(host, p.projectId as string, { id: worktree.repoId, path: worktree.repoPath })
      return env.up({ repoKey, branch: worktree.branch as string, worktreePath: worktree.path, settings, envVars }, logTo(ctx))
    },

    stop: (p, ctx) => env.stop(requireProfile(p.profile), logTo(ctx)),

    // The registry's worktree path (an import may have brought it) is where compose down runs, only
    // where the host lets a program run; elsewhere only the VM is deleted.
    destroy: (p, ctx) => {
      const profile = requireProfile(p.profile)
      assertProfileFree(profile)
      return env.destroy(profile, logTo(ctx))
    },

    ps: async (p) => {
      const { worktree, profile } = await environmentOf(p)
      const composeFile = optionalComposeFile(p.composeFile, worktree.path)
      return viaTool(() => env.ps(profile, worktree.path, composeFile))
    },

    composeFiles: async (p) => env.composeFiles((await host.checkedWorktree(p.projectId, p.worktreeId)).path),

    logs: async (p) => {
      const { worktree, profile } = await environmentOf(p)
      const composeFile = optionalComposeFile(p.composeFile, worktree.path)
      const service = requireService(p.service)
      const tail = optionalInt(p.tail, 'tail', 1, 5000, 300)
      return viaTool(() => env.logs(profile, worktree.path, composeFile, service, tail))
    }
  }
}
