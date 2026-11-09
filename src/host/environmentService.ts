// The per-worktree Colima environments on the machine this runs on (trek-server's, phase 5a): the
// registry that maps each VM back to its repository, branch and worktree, and the operations on
// it. Electron-free: the registry's file is the caller's (the server's data dir), and the server
// checks every argument before it calls these.
import { access, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import {
  checkTools,
  composeDownVolumes,
  composeLogs,
  composePs,
  composeUp,
  deleteVm,
  listColimaProfiles,
  splitComposeFiles,
  startVm,
  stopVm
} from './colimaService.ts'
import { ENV_DEFAULTS, ENV_PROFILE_PREFIX, deriveProfileName, registryUnreadableMessage } from '../shared/environments.ts'
import type {
  EnvCheckResult,
  EnvLogEvent,
  EnvService,
  EnvUpResult,
  EnvUpStep,
  EnvVmState,
  EnvironmentInfo,
  EnvironmentSettings
} from '../shared/types'

/**
 * VMs are machine state, not project state: the registry maps each profile back to the
 * repo/branch/worktree that owns it, which is what makes orphan detection possible (profile
 * names hash, they don't invert). `repoPath` is the repository's envRepoKey.
 */
export interface RegistryEntry {
  repoPath: string
  branch: string
  worktreePath: string
  composeFile?: string
  /** Extra env for docker compose (variable substitution), from the Env tab */
  envVars?: Record<string, string>
  createdAt: string
}

export type Registry = Record<string, RegistryEntry>

export type EnvLog = (event: EnvLogEvent) => void

export interface EnvUpRequest {
  /** The repository's envRepoKey: the path its VM names hash */
  repoKey: string
  branch: string
  worktreePath: string
  settings: EnvironmentSettings | undefined
  envVars: Record<string, string> | undefined
}

export interface EnvironmentService {
  check(): Promise<EnvCheckResult>
  list(repoKey: string): Promise<EnvironmentInfo[]>
  up(request: EnvUpRequest, onLog: EnvLog): Promise<EnvUpResult>
  stop(profile: string, onLog: EnvLog): Promise<number>
  /** `composeAllowed` says whether docker compose may run in the registry's worktree path (the server's allowlist); if not, only the VM is deleted */
  destroy(profile: string, onLog: EnvLog, composeAllowed: (worktreePath: string) => boolean): Promise<number>
  ps(profile: string, worktreePath: string, composeFile: string | undefined): Promise<EnvService[]>
  composeFiles(worktreePath: string): Promise<string[]>
  logs(profile: string, worktreePath: string, composeFile: string | undefined, service: string, tail: number): Promise<string>
  /** Whether the registry knows the profile */
  known(profile: string): Promise<boolean>
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/** colima start failed because the vmnet sudo helper isn't installed yet. */
const isSudoHelperFailure = (output: string): boolean => /sudo|vmnet|password/i.test(output)

/** A compose file name the environments' picker lists: docker-compose.yml, compose.dev.yaml, … */
export const COMPOSE_FILE_RE = /^(docker-)?compose([.-][^.]+)*\.(yml|yaml)$/i

export interface EnvironmentServiceOptions {
  /** The registry's JSON file (the server's `<dataDir>/environments.json`) */
  registryFile: string
  /** VMs mount only this directory by default (Colima's $HOME); the worktree must be under it */
  home?: string
}

export function createEnvironmentService(options: EnvironmentServiceOptions): EnvironmentService {
  const { registryFile } = options
  const home = options.home ?? homedir()

  /**
   * No file is an empty registry. Any other failure to read or parse it throws when `strict` (a
   * change, which must not write an empty registry over the entries it could not read, and
   * `list`, which would show every VM as an orphan to delete); the other reads take it as empty.
   */
  const readRegistry = async (strict = false): Promise<Registry> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(registryFile, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || !strict) return {}
      throw new Error(registryUnreadableMessage(registryFile, (err as Error).message))
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Registry
    if (!strict) return {}
    throw new Error(registryUnreadableMessage(registryFile, 'it is not a JSON object'))
  }
  // Write-then-rename: a crash mid-write must not leave a torn file, which would read as no VMs.
  const writeRegistry = async (registry: Registry): Promise<void> => {
    const tmp = `${registryFile}.${process.pid}.tmp`
    // 0600: a branch's variables may hold secrets. writeFile keeps the mode of a temp file a crash
    // left behind, so that one goes first.
    await rm(tmp, { force: true })
    await writeFile(tmp, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, registryFile)
  }
  /**
   * Every change goes through here, one at a time: read, change, write. Operations on two
   * profiles run at once (several clients), and each must not write back a registry read
   * before the other's change. The lock is in-process: one server per data dir.
   */
  let registryLock: Promise<unknown> = Promise.resolve()
  const updateRegistry = <T>(change: (registry: Registry) => T): Promise<T> => {
    const next = registryLock.then(async () => {
      const registry = await readRegistry(true)
      const result = change(registry)
      await writeRegistry(registry)
      return result
    })
    registryLock = next.catch(() => {})
    return next
  }
  const entryOf = (registry: Registry, profile: string): RegistryEntry | undefined => (Object.hasOwn(registry, profile) ? registry[profile] : undefined)

  /** Serialize operations per profile so double-clicks can't race two colima runs. */
  const opQueues = new Map<string, Promise<unknown>>()
  const enqueue = <T>(profile: string, work: () => Promise<T>): Promise<T> => {
    const prev = opQueues.get(profile) ?? Promise.resolve()
    const next = prev.then(work, work)
    opQueues.set(profile, next)
    return next
  }

  const logSender = (profile: string, onLog: EnvLog) => {
    let tail = ''
    const send = (data: string, done?: boolean, step?: EnvUpStep): void => {
      tail = (tail + data).slice(-8_192)
      onLog({ profile, data, ...(done ? { done } : {}), ...(step ? { step } : {}) })
    }
    return {
      onData: (data: string) => send(data),
      finish: (data: string) => send(data, true),
      step: (step: EnvUpStep) => send('', false, step),
      tail: () => tail
    }
  }

  let toolCheck: EnvCheckResult | null = null

  return {
    async check() {
      if (toolCheck?.ok) return toolCheck
      toolCheck = await checkTools()
      return toolCheck
    },

    async known(profile) {
      return entryOf(await readRegistry(), profile) !== undefined
    },

    async list(repoKey) {
      // Strict: an unreadable registry would list every VM as an orphan to delete.
      const [registry, profiles] = await Promise.all([readRegistry(true), listColimaProfiles()])
      const byName = new Map(profiles.map((p) => [p.name, p]))
      const infos: EnvironmentInfo[] = []
      for (const [profile, entry] of Object.entries(registry)) {
        if (entry.repoPath !== repoKey) continue
        const vm = byName.get(profile)
        const vmState: EnvVmState = vm == null ? 'missing' : vm.status === 'Running' ? 'running' : 'stopped'
        infos.push({
          profile,
          ...entry,
          vmState,
          address: vm?.address,
          orphaned: (await exists(entry.worktreePath)) ? undefined : true
        })
      }
      // twb- VMs with no registry entry (crash leftovers): surfaced for cleanup.
      for (const vm of profiles) {
        if (!vm.name.startsWith(ENV_PROFILE_PREFIX) || entryOf(registry, vm.name)) continue
        infos.push({
          profile: vm.name,
          repoPath: repoKey,
          branch: '',
          worktreePath: '',
          vmState: vm.status === 'Running' ? 'running' : 'stopped',
          address: vm.address,
          orphaned: true
        })
      }
      return infos
    },

    up({ repoKey, branch, worktreePath, settings, envVars }, onLog) {
      const profile = deriveProfileName(repoKey, branch)
      const log = logSender(profile, onLog)
      return enqueue(profile, async (): Promise<EnvUpResult> => {
        const composeFile = settings?.composeFile || ENV_DEFAULTS.composeFile
        const fail = (error: string): EnvUpResult => {
          log.finish(`error: ${error}\n`)
          return { code: -1, error }
        }
        for (const file of splitComposeFiles(composeFile)) {
          const composePath = join(worktreePath, file)
          if (!(await exists(composePath))) return fail(`No compose file at ${composePath}`)
        }
        const inHome = relative(home, worktreePath)
        if (inHome.startsWith('..') || isAbsolute(inHome)) {
          return fail(`Worktree is outside the home directory (${worktreePath}) — Colima only mounts $HOME by default`)
        }

        // Registered before starting so a crash mid-boot still leaves a trail.
        try {
          await updateRegistry((registry) => {
            registry[profile] = {
              repoPath: repoKey,
              branch,
              worktreePath,
              composeFile,
              envVars: envVars && Object.keys(envVars).length > 0 ? envVars : undefined,
              createdAt: entryOf(registry, profile)?.createdAt ?? new Date().toISOString()
            }
          })
        } catch (err) {
          return fail((err as Error).message)
        }

        const networkAddress = settings?.networkAddress ?? ENV_DEFAULTS.networkAddress
        log.step('vm')
        const vmCode = await startVm(
          profile,
          {
            cpu: settings?.cpu ?? ENV_DEFAULTS.cpu,
            memory: settings?.memory ?? ENV_DEFAULTS.memory,
            disk: settings?.disk ?? ENV_DEFAULTS.disk,
            networkAddress,
            rosetta: settings?.rosetta ?? ENV_DEFAULTS.rosetta
          },
          log.onData
        )
        if (vmCode !== 0) {
          if (networkAddress && isSudoHelperFailure(log.tail())) {
            return fail(
              `Colima's network helper needs a one-time sudo install. Run "colima start ${profile} --network-address" in a terminal on the server's machine once, or disable "Per-VM IP address" in Settings.`
            )
          }
          return fail(`colima start exited with code ${vmCode}`)
        }

        log.step('compose')
        const composeCode = await composeUp(profile, worktreePath, composeFile, log.onData, envVars)
        if (composeCode !== 0) return fail(`docker compose up exited with code ${composeCode}`)

        log.step('ready')
        let address: string | undefined
        try {
          address = (await listColimaProfiles()).find((p) => p.name === profile)?.address
        } catch {
          // non-fatal: the env.list poll picks the address up
        }
        log.finish('[environment ready]\n')
        return { code: 0, address }
      })
    },

    stop(profile, onLog) {
      const log = logSender(profile, onLog)
      return enqueue(profile, async () => {
        const code = await stopVm(profile, log.onData)
        log.finish(`[colima stop exited with code ${code}]\n`)
        return code
      })
    },

    destroy(profile, onLog, composeAllowed) {
      const log = logSender(profile, onLog)
      return enqueue(profile, async () => {
        // Belt-and-braces for bind-mount cleanup; the volumes die with the VM anyway, so a
        // failure (VM stopped, compose file gone) is fine.
        const entry = entryOf(await readRegistry(), profile)
        if (entry && !composeAllowed(entry.worktreePath)) {
          log.onData(`skipping docker compose down: ${entry.worktreePath} is outside the server's allowed paths\n`)
        } else if (entry && (await exists(entry.worktreePath))) {
          const composeFile = entry.composeFile || ENV_DEFAULTS.composeFile
          let timer: NodeJS.Timeout | undefined
          await Promise.race([
            composeDownVolumes(profile, entry.worktreePath, composeFile, log.onData, entry.envVars),
            new Promise((resolve) => {
              timer = setTimeout(resolve, 60_000, -1)
            })
          ])
            .catch(() => -1)
            .finally(() => clearTimeout(timer))
        }
        const code = await deleteVm(profile, log.onData)
        try {
          await updateRegistry((registry) => {
            delete registry[profile]
          })
        } catch (err) {
          log.finish(`error: ${(err as Error).message}\n`)
          return -1
        }
        log.finish(`[environment destroyed]\n`)
        return code
      })
    },

    async ps(profile, worktreePath, composeFile) {
      const entry = entryOf(await readRegistry(), profile)
      return composePs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, entry?.envVars)
    },

    // Compose file candidates in the worktree root, for the Apply-compose picker.
    async composeFiles(worktreePath) {
      try {
        const entries = await readdir(worktreePath)
        return entries.filter((f) => COMPOSE_FILE_RE.test(f)).sort((a, b) => a.length - b.length || a.localeCompare(b))
      } catch {
        return []
      }
    },

    async logs(profile, worktreePath, composeFile, service, tail) {
      const entry = entryOf(await readRegistry(), profile)
      return composeLogs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, service, tail, entry?.envVars)
    }
  }
}
