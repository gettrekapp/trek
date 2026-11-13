// Colima and docker compose for the environments (environmentService.ts), on trek-server's machine. Electron-free.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { dockerContextFor } from '../shared/environments.ts'
import type { EnvCheckResult, EnvService, EnvServicePort } from '../shared/types'
import { hidden } from './childOptions.ts'
import { commandPath } from './commandPath.ts'

const execFileAsync = promisify(execFile)

export type OnData = (chunk: string) => void

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

export async function checkTools(): Promise<EnvCheckResult> {
  const version = async (bin: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(commandPath(bin), args, hidden({ timeout: 10_000 }))
    return stdout.trim().split('\n')[0]
  }
  let colimaVersion: string
  try {
    colimaVersion = await version('colima', ['--version'])
  } catch {
    return { ok: false, error: 'colima not found on PATH — brew install colima' }
  }
  try {
    const dockerVersion = await version('docker', ['--version'])
    return { ok: true, colimaVersion, dockerVersion }
  } catch {
    return { ok: false, colimaVersion, error: 'docker CLI not found on PATH — brew install docker docker-compose' }
  }
}

export async function listColimaProfiles(): Promise<ColimaProfile[]> {
  // Line-delimited JSON; empty output when no VMs exist yet.
  const { stdout } = await execFileAsync(commandPath('colima'), ['list', '--json'], hidden({ timeout: 30_000 }))
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const raw = JSON.parse(line) as Record<string, unknown>
      return {
        name: String(raw.name ?? ''),
        status: String(raw.status ?? ''),
        address: typeof raw.address === 'string' && raw.address ? raw.address : undefined
      }
    })
    .filter((p) => p.name)
}

export type EnvVars = Record<string, string>

/** Extra vars layered over the server's own env (compose reads them for ${VAR} substitution). */
const mergedEnv = (extra?: EnvVars): NodeJS.ProcessEnv =>
  extra && Object.keys(extra).length > 0 ? { ...process.env, ...extra } : process.env

/** Streams combined output via onData, resolves the exit code. */
function run(
  bin: string,
  args: string[],
  onData: OnData,
  cwd?: string,
  env?: EnvVars
): Promise<number> {
  return new Promise((resolve) => {
    onData(`$ ${bin} ${args.join(' ')}\n`)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(commandPath(bin), args, hidden({ cwd, env: mergedEnv(env) }))
    } catch (err) {
      // Windows: not on PATH (commandPath never falls back to the cwd).
      onData(`error: ${(err as Error).message}\n`)
      resolve(-1)
      return
    }
    child.stdout!.on('data', (chunk: Buffer) => onData(chunk.toString()))
    child.stderr!.on('data', (chunk: Buffer) => onData(chunk.toString()))
    child.on('error', (err) => {
      onData(`error: ${err.message}\n`)
      resolve(-1)
    })
    child.on('close', (code) => resolve(code ?? -1))
  })
}

/**
 * Create-or-start the VM. Idempotent: starting an existing profile ignores
 * the provisioning flags. No kill-timeout — first boot can take minutes.
 */
export function startVm(profile: string, opts: VmStartOptions, onData: OnData): Promise<number> {
  return run(
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
    onData
  )
}

export const stopVm = (profile: string, onData: OnData): Promise<number> =>
  run('colima', ['stop', profile], onData)

export const deleteVm = (profile: string, onData: OnData): Promise<number> =>
  run('colima', ['delete', profile, '--force'], onData)

/** A composeFile may be a comma-separated list — layered as multiple -f flags. */
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

export const composeUp = (
  profile: string,
  worktreePath: string,
  composeFile: string,
  onData: OnData,
  envVars?: EnvVars
): Promise<number> =>
  run('docker', composeArgs(profile, composeFile, ['up', '-d']), onData, worktreePath, envVars)

export const composeDownVolumes = (
  profile: string,
  worktreePath: string,
  composeFile: string,
  onData: OnData,
  envVars?: EnvVars
): Promise<number> =>
  run('docker', composeArgs(profile, composeFile, ['down', '-v']), onData, worktreePath, envVars)

/** Recent log tail for one compose service (containers write to both streams). */
export async function composeLogs(
  profile: string,
  worktreePath: string,
  composeFile: string,
  service: string,
  tail: number,
  envVars?: EnvVars
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    commandPath('docker'),
    composeArgs(profile, composeFile, ['logs', '--no-color', '--tail', String(tail), service]),
    hidden({ timeout: 30_000, cwd: worktreePath, maxBuffer: 16 * 1024 * 1024, env: mergedEnv(envVars) })
  )
  return stdout + stderr
}

export async function composePs(
  profile: string,
  worktreePath: string,
  composeFile: string,
  envVars?: EnvVars
): Promise<EnvService[]> {
  const { stdout } = await execFileAsync(
    commandPath('docker'),
    composeArgs(profile, composeFile, ['ps', '--format', 'json']),
    hidden({ timeout: 30_000, cwd: worktreePath, env: mergedEnv(envVars) })
  )
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

function parsePublishers(publishers: unknown): EnvServicePort[] {
  if (!Array.isArray(publishers)) return []
  const ports: EnvServicePort[] = []
  for (const p of publishers as Record<string, unknown>[]) {
    const published = Number(p?.PublishedPort ?? 0)
    if (!published) continue // unpublished/internal-only port
    ports.push({
      published,
      target: Number(p?.TargetPort ?? 0),
      protocol: String(p?.Protocol ?? 'tcp')
    })
  }
  // Publishers repeats per bind address (0.0.0.0 and ::) — dedupe.
  const seen = new Set<string>()
  return ports.filter((p) => {
    const key = `${p.published}/${p.protocol}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
