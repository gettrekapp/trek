// colima and docker for the Colima environments, through the plugin host's programs (plugins E2;
// before, core's own Colima service, since removed, ran them itself): the quick reads (`--version`, `colima list`,
// compose ps) on host.run; the runs whose output streams (colima start, stop and delete, compose up
// and down) and a service's logs (both streams) on host.spawn. colima runs in the plugin's data
// directory, docker compose in the worktree. Never a shell: every argument is a list entry.
import type { ServerPluginHost, SpawnedProgram } from '../../../src/shared/plugins/server.ts'
import { dockerContextFor } from '../shared/environments.ts'
import type { EnvCheckResult, EnvService, EnvServicePort } from '../shared/types.ts'

export type OnData = (chunk: string) => void
export type EnvVars = Record<string, string>

export interface VmStartOptions {
  cpu: number
  memory: number
  disk: number
  networkAddress: boolean
  rosetta: boolean
}

export interface ColimaProfile {
  name: string
  status: string // "Running" | "Stopped"
  address?: string
}

export interface StreamOptions {
  /** Kills the run when it aborts */
  signal?: AbortSignal
  /**
   * The host refused the working directory (not a project's worktree, gone, or outside the allowed
   * paths): told here, not as the log's error line. Only the host's refusal: a program that could
   * not start (an OS error code such as EACCES) is an `error:` line as any other.
   */
  refused?: (message: string) => void
  /** host.spawn's `outlive`: a server Stop, Restart or Update doesn't cut it off (colima start, compose up) */
  outlive?: boolean
}

/** For tests: shorter limits than the real ones */
export interface ToolLimits {
  /** How long a service's logs may take; default 30 s */
  logsTimeoutMs?: number
}

export interface Tools {
  checkTools(): Promise<EnvCheckResult>
  listColimaProfiles(): Promise<ColimaProfile[]>
  /** Create-or-start the VM. Idempotent: starting an existing profile ignores the provisioning flags. No timeout: a first boot can take minutes. */
  startVm(profile: string, opts: VmStartOptions, onData: OnData): Promise<number>
  stopVm(profile: string, onData: OnData): Promise<number>
  deleteVm(profile: string, onData: OnData): Promise<number>
  composeUp(profile: string, worktreePath: string, composeFile: string, onData: OnData, envVars?: EnvVars): Promise<number>
  composeDownVolumes(profile: string, worktreePath: string, composeFile: string, onData: OnData, envVars?: EnvVars, options?: StreamOptions): Promise<number>
  /** A service's recent lines, stdout then stderr (containers write to both) */
  composeLogs(profile: string, worktreePath: string, composeFile: string, service: string, tail: number, envVars?: EnvVars): Promise<string>
  composePs(profile: string, worktreePath: string, composeFile: string, envVars?: EnvVars): Promise<EnvService[]>
}

/**
 * The most text a service's logs may be, both streams together: about 16 MiB, counted in UTF-16
 * characters as they arrive (not bytes, as the old execFile maxBuffer was). Past it the program is
 * stopped.
 */
const LOGS_MAX_CHARS = 16 * 1024 * 1024

/** The host's refusal of a cwd (the registry's programCwd: a plain Error; the path guard's PATH_DENIED), not a program's own failure to start (ENOENT, ABORT_ERR, an OS errno code). */
const isCwdRefusal = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code
  return code === undefined || code === 'PATH_DENIED'
}

const seconds = (ms: number): string => `${ms / 1000} s`
/** A composeFile may be a comma-separated list, layered as several -f flags. */
export const splitComposeFiles = (composeFile: string): string[] =>
  composeFile
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)

const composeArgs = (profile: string, composeFile: string, rest: string[]): string[] => [
  '--context',
  dockerContextFor(profile),
  'compose',
  ...splitComposeFiles(composeFile).flatMap((f) => ['-f', f]),
  ...rest
]

/** The variables for docker compose (its ${VAR} substitution), when there are any. */
const withVars = (envVars: EnvVars | undefined): { env?: EnvVars } => (envVars && Object.keys(envVars).length > 0 ? { env: envVars } : {})

const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)

function parsePublishers(publishers: unknown): EnvServicePort[] {
  if (!Array.isArray(publishers)) return []
  const ports: EnvServicePort[] = []
  for (const p of publishers as Record<string, unknown>[]) {
    const published = Number(p?.PublishedPort ?? 0)
    if (!published) continue // unpublished/internal-only port
    ports.push({ published, target: Number(p?.TargetPort ?? 0), protocol: String(p?.Protocol ?? 'tcp') })
  }
  // Publishers repeats per bind address (0.0.0.0 and ::): dedupe.
  const seen = new Set<string>()
  return ports.filter((p) => {
    const key = `${p.published}/${p.protocol}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** `colimaDir`: the plugin's data directory, where colima runs (host.spawn needs a cwd). */
export function createTools(host: Pick<ServerPluginHost, 'run' | 'spawn'>, colimaDir: string, limits: ToolLimits = {}): Tools {
  const { logsTimeoutMs = 30_000 } = limits
  /** Streams combined output through onData and resolves the exit code; a program that can't start is -1, said in the output. */
  const stream = async (command: string, args: string[], onData: OnData, cwd: string, envVars?: EnvVars, options: StreamOptions = {}): Promise<number> => {
    onData(`$ ${command} ${args.join(' ')}\n`)
    let program: SpawnedProgram
    try {
      program = await host.spawn(command, args, { cwd, ...withVars(envVars), ...(options.signal ? { signal: options.signal } : {}), ...(options.outlive ? { outlive: true } : {}), onOutput: (_stream, chunk) => onData(chunk) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (options.refused && isCwdRefusal(err)) options.refused(message)
      else onData(`error: ${message}\n`)
      return -1
    }
    const end = await program.done
    return end.code ?? -1
  }

  return {
    async checkTools() {
      const version = async (bin: string): Promise<string> => (await host.run(bin, ['--version'], { timeoutMs: 10_000 })).trim().split('\n')[0]
      let colimaVersion: string
      try {
        colimaVersion = await version('colima')
      } catch {
        return { ok: false, error: 'colima not found on PATH — brew install colima' }
      }
      try {
        return { ok: true, colimaVersion, dockerVersion: await version('docker') }
      } catch {
        return { ok: false, colimaVersion, error: 'docker CLI not found on PATH — brew install docker docker-compose' }
      }
    },

    async listColimaProfiles() {
      // Line-delimited JSON; empty output when no VMs exist yet.
      const stdout = await host.run('colima', ['list', '--json'], { timeoutMs: 30_000 })
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const raw = JSON.parse(line) as Record<string, unknown>
          return { name: String(raw.name ?? ''), status: String(raw.status ?? ''), address: typeof raw.address === 'string' && raw.address ? raw.address : undefined }
        })
        .filter((p) => p.name)
    },

    startVm: (profile, opts, onData) =>
      stream(
        'colima',
        [
          'start',
          profile,
          '--cpu',
          String(opts.cpu),
          '--memory',
          String(opts.memory),
          '--disk',
          String(opts.disk),
          ...(opts.networkAddress ? ['--network-address'] : []),
          // Rosetta needs Apple's VZ runtime (Apple Silicon, macOS 13+).
          ...(opts.rosetta ? ['--vm-type', 'vz', '--vz-rosetta'] : [])
        ],
        onData,
        colimaDir,
        undefined,
        // A VM half started by a cut-off `colima start` is worse than one the restart let finish.
        { outlive: true }
      ),

    stopVm: (profile, onData) => stream('colima', ['stop', profile], onData, colimaDir),

    deleteVm: (profile, onData) => stream('colima', ['delete', profile, '--force'], onData, colimaDir),

    composeUp: (profile, worktreePath, composeFile, onData, envVars) => stream('docker', composeArgs(profile, composeFile, ['up', '-d']), onData, worktreePath, envVars, { outlive: true }),

    composeDownVolumes: (profile, worktreePath, composeFile, onData, envVars, options) =>
      stream('docker', composeArgs(profile, composeFile, ['down', '-v']), onData, worktreePath, envVars, options),

    async composeLogs(profile, worktreePath, composeFile, service, tail, envVars) {
      const out = { stdout: '', stderr: '' }
      let size = 0
      let program: SpawnedProgram | undefined
      const signal = AbortSignal.timeout(logsTimeoutMs)
      const timedOut = (): Error => new Error(`docker compose logs timed out after ${seconds(logsTimeoutMs)}`)
      try {
        program = await host.spawn('docker', composeArgs(profile, composeFile, ['logs', '--no-color', '--tail', String(tail), service]), {
          cwd: worktreePath,
          ...withVars(envVars),
          signal,
          onOutput: (which, chunk) => {
            size += chunk.length
            if (size <= LOGS_MAX_CHARS) out[which] += chunk
            else program?.kill()
          }
        })
      } catch (err) {
        if (signal.aborted) throw timedOut()
        throw err
      }
      // Past the cap before spawn resolved (onOutput had no program to kill yet)
      if (size > LOGS_MAX_CHARS) program.kill()
      const end = await program.done
      if (size > LOGS_MAX_CHARS) throw new Error("docker compose logs' output passed about 16 MiB")
      if (signal.aborted) throw timedOut()
      if (end.code !== 0) throw new Error(firstLine(out.stderr) ?? `docker compose logs exited with ${end.code ?? end.signal}`)
      return out.stdout + out.stderr
    },

    async composePs(profile, worktreePath, composeFile, envVars) {
      const stdout = await host.run('docker', composeArgs(profile, composeFile, ['ps', '--format', 'json']), { cwd: worktreePath, timeoutMs: 30_000, ...withVars(envVars) })
      // Compose emits a JSON array in some versions, line-delimited objects in others.
      const trimmed = stdout.trim()
      if (!trimmed) return []
      const rows: Record<string, unknown>[] = trimmed.startsWith('[')
        ? (JSON.parse(trimmed) as Record<string, unknown>[])
        : trimmed
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
      return rows.map((raw) => ({
        name: String(raw.Service ?? raw.Name ?? ''),
        state: String(raw.State ?? ''),
        status: String(raw.Status ?? ''),
        ports: parsePublishers(raw.Publishers)
      }))
    }
  }
}
