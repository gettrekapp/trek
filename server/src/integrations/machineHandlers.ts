// Docker, the Colima environments and the dev stacks, on the server's machine (phase 5a; the
// `docker`, `env` and `stacks` capabilities). Before 5a the app's main process ran these on the
// client's machine, so only a Local window had them; now any server window does, and they act on
// the server's machine and its paths.
//
// The token already grants a shell as the server user (PROTOCOL.md, "Auth"); these add no new
// power, and are held to the rest of the protocol's rules: every path comes from the server's own
// state (a project, a repository or worktree id, never a client path), passes the path allowlist,
// and every other argument is checked (args.ts) before it reaches a command line, which is always
// an argument list (execFile, spawn), never a shell. A tool the machine lacks is a TOOL_ERROR with
// `details.reason: missing`, never a crash.
import { envRepoKey } from '../../../src/shared/environments.ts'
import * as docker from '../../../src/host/dockerService.ts'
import type { EnvironmentService } from '../../../src/host/environmentService.ts'
import type { StackService } from '../../../src/host/stackService.ts'
import { REGISTRY_REASON, deriveProfileName } from '../../../src/shared/environments.ts'
import type { EventPayloadsV2 } from '../../../src/shared/protocolV2'
import { codedError } from '../errors.ts'
import { SINK_HIGH_WATER, SINK_LOW_WATER } from '../sessions/terminalHost.ts'
import { findRegistered, repoIn } from '../projects/model.ts'
import { requireBoolean } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkedOut, present } from '../worktreeHandlers.ts'
import {
  optionalComposeFile,
  optionalEnvVars,
  optionalInt,
  requireComposeAction,
  requireContainerAction,
  requireContainerId,
  requireEnvSettings,
  requireInt,
  requireProfile,
  requireService
} from './args.ts'

/** The machine's services, made once per server (server.ts) with their files in its data dir. */
export interface Machine {
  env: EnvironmentService
  stacks: StackService
}

/** This connection, as a receiver of the events it asked for (`docker.log`, `env.log`). */
export interface EventSink {
  send<E extends keyof EventPayloadsV2>(event: E, payload: EventPayloadsV2[E]): void
}

const DROPPED = '[output dropped: the connection fell behind]\n'

/**
 * A connection's event sink with the terminal sink's backpressure: past SINK_HIGH_WATER unsent
 * bytes a log chunk is dropped (a step or a `done` never is), and the next chunk sent for that run
 * (its event and, for env.log, its profile) follows one DROPPED chunk. Sending resumes below
 * SINK_LOW_WATER.
 */
export function createEventSink(send: (event: string, payload: unknown) => void, bufferedAmount: () => number): EventSink {
  const dropped = new Set<string>()
  let congested = false
  return {
    send(event, payload) {
      const p = payload as { done?: boolean; step?: unknown; profile?: string }
      const key = `${event}\0${p.profile ?? ''}`
      const buffered = bufferedAmount()
      congested = congested ? buffered > SINK_LOW_WATER : buffered > SINK_HIGH_WATER
      if (congested && p.done !== true && p.step === undefined) {
        dropped.add(key)
        return
      }
      if (p.step === undefined && dropped.delete(key)) send(event, p.profile !== undefined ? { profile: p.profile, data: DROPPED } : { data: DROPPED })
      send(event, payload)
    }
  }
}

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/**
 * The program a failed execFile or spawn ran, when it was not found on PATH. Only a spawn's ENOENT:
 * a file's (a log removed between its stat and its open) is an ordinary failure.
 */
function missingTool(err: unknown): string | null {
  const e = err as { code?: unknown; path?: unknown; syscall?: unknown } | null
  if (e?.code !== 'ENOENT' || typeof e.syscall !== 'string' || !e.syscall.startsWith('spawn')) return null
  if (typeof e.path === 'string' && e.path !== '') return e.path
  return typeof e.syscall === 'string' && e.syscall.startsWith('spawn ') ? e.syscall.slice('spawn '.length) : 'the tool'
}

/**
 * Runs a tool: a failure is TOOL_ERROR (`missing` when the program is not installed, `registry`
 * when the environments registry cannot be read), never INTERNAL.
 */
async function viaTool<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if ((err as { code?: unknown }).code === 'BAD_REQUEST') throw err
    const tool = missingTool(err)
    if (tool) throw codedError('TOOL_ERROR', `${tool} is not installed on the server (it is not on the server's PATH)`, { reason: 'missing' })
    const message = (err as Error).message ?? String(err)
    const details = (err as { reason?: unknown }).reason === REGISTRY_REASON ? { reason: REGISTRY_REASON } : undefined
    throw codedError('TOOL_ERROR', message.length > 4000 ? `${message.slice(0, 4000)}…` : message, details)
  }
}

const machine = (ctx: V2Context): Machine => {
  if (!ctx.machine) throw codedError('NOT_FOUND', 'this server has no machine services')
  return ctx.machine
}

/** A repository the project has and the registry still has, inside the allowlist: its main checkout. */
function repository(ctx: V2Context, p: any) {
  const repo = repoIn(ctx.projects.require(p.projectId), p.repoId)
  findRegistered(ctx.store.config.repos, repo.path)
  ctx.store.guard.check(repo.path)
  return repo
}

/** The worktree's branch's environment: its VM is named after the repository's envRepoKey and the branch. */
function environmentOf(ctx: V2Context, p: any) {
  const { repo, worktree } = present(ctx, p)
  if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD)`)
  return { repo, worktree, profile: deriveProfileName(envRepoKey(repo), worktree.branch) }
}

const allMachineHandlers: Record<string, Handler> = {
  'docker.list': () => viaTool(() => docker.listContainers()),

  'docker.container': async (p) => {
    const action = requireContainerAction(p.action)
    const id = requireContainerId(p.id)
    await viaTool(() => docker.containerAction(action, id))
    return null
  },

  // Its output streams to this connection as docker.log; a docker that is not installed ends the
  // run with code -1 and says so in the output.
  'docker.compose': (p, ctx) => {
    const action = requireComposeAction(p.action)
    const repo = repository(ctx, p)
    return docker.compose(action, repo.path, (event) => ctx.events?.send('docker.log', event))
  },

  'env.check': (_p, ctx) => machine(ctx).env.check(),

  'env.list': (p, ctx) => {
    const repo = repository(ctx, p)
    return viaTool(() => machine(ctx).env.list(envRepoKey(repo)))
  },

  // The branch git has checked out now (re-read), the repository's VM key from the server's own
  // data, the settings and variables checked. The output streams to this connection as env.log.
  'env.up': async (p, ctx) => {
    const env = machine(ctx).env
    const { repo, worktree, branch } = await checkedOut(ctx, p)
    const settings = requireEnvSettings(p.settings, worktree.path)
    const envVars = optionalEnvVars(p.envVars)
    return env.up({ repoKey: envRepoKey(repo), branch, worktreePath: worktree.path, settings, envVars }, (event) => ctx.events?.send('env.log', event))
  },

  'env.stop': (p, ctx) => {
    const profile = requireProfile(p.profile)
    return machine(ctx).env.stop(profile, (event) => ctx.events?.send('env.log', event))
  },

  // The registry's worktree path (an import may have brought it) is checked like any other before
  // docker compose runs in it; outside the allowlist, or gone, only the VM is deleted.
  'env.destroy': (p, ctx) => {
    const profile = requireProfile(p.profile)
    const allowed = (path: string): boolean => {
      try {
        ctx.store.guard.check(path)
        return true
      } catch {
        return false
      }
    }
    return machine(ctx).env.destroy(profile, (event) => ctx.events?.send('env.log', event), allowed)
  },

  'env.ps': (p, ctx) => {
    const { worktree, profile } = environmentOf(ctx, p)
    const composeFile = optionalComposeFile(p.composeFile, worktree.path)
    return viaTool(() => machine(ctx).env.ps(profile, worktree.path, composeFile))
  },

  'env.composeFiles': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return machine(ctx).env.composeFiles(worktree.path)
  },

  'env.logs': (p, ctx) => {
    const { worktree, profile } = environmentOf(ctx, p)
    const composeFile = optionalComposeFile(p.composeFile, worktree.path)
    const service = requireService(p.service)
    const tail = optionalInt(p.tail, 'tail', 1, 5000, 300)
    return viaTool(() => machine(ctx).env.logs(profile, worktree.path, composeFile, service, tail))
  },

  'stack.status': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaTool(() => machine(ctx).stacks.status(worktree.path))
  },

  'stack.up': async (p, ctx) => {
    const starter = requireBoolean(p.starter, 'starter')
    const { worktree } = present(ctx, p)
    await viaTool(() => machine(ctx).stacks.up(worktree.path, starter))
    return null
  },

  'stack.down': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaTool(() => machine(ctx).stacks.down(worktree.path))
  },

  'stack.destroy': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaTool(() => machine(ctx).stacks.destroy(worktree.path))
  },

  'stack.log': (p, ctx) => {
    const fileId = requireInt(p.fileId, 'fileId', 0, Number.MAX_SAFE_INTEGER)
    const offset = requireInt(p.offset, 'offset', 0, Number.MAX_SAFE_INTEGER)
    const { worktree } = present(ctx, p)
    return viaTool(() => machine(ctx).stacks.log(worktree.path, fileId, offset))
  }
}

/** Methods this server does not serve on Windows yet (W3 brings Docker Desktop and Git Bash). */
export const WINDOWS_UNSUPPORTED_PREFIXES = ['env.', 'stack.'] as const

/**
 * The handlers for `platform`: on Windows, environments (Colima runs only on macOS and Linux) and
 * dev stacks (stack.sh needs bash) answer TOOL_ERROR `unsupported`, and the welcome leaves their
 * capabilities out, so clients hide them. Docker stays: the docker CLI works there.
 */
export function machineHandlersFor(platform: NodeJS.Platform): Record<string, Handler> {
  if (platform !== 'win32') return allMachineHandlers
  const out: Record<string, Handler> = {}
  for (const [method, handler] of Object.entries(allMachineHandlers)) {
    const unsupported = WINDOWS_UNSUPPORTED_PREFIXES.some((prefix) => method.startsWith(prefix))
    out[method] = unsupported
      ? () => {
          throw codedError('TOOL_ERROR', `${method.startsWith('env.') ? 'Environments are' : 'Dev stacks are'} not yet supported on Windows servers`, { reason: 'unsupported' })
        }
      : handler
  }
  return out
}

export const machineHandlers: Record<string, Handler> = machineHandlersFor(process.platform)
