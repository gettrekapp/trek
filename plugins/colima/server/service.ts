// The Colima environments on the server's machine (plugins E2; core's own environment service, since
// removed, before): the registry that maps each VM back to its repository, branch and worktree, and the
// operations on it, through the plugin's tools (tools.ts: the host's programs). The handlers check
// every argument before they call these.
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { writeFileAtomic } from '../../../src/shared/plugins/server.ts'
import { ENV_DEFAULTS, ENV_PROFILE_PREFIX, REGISTRY_REASON, deriveProfileName, registryUnreadableMessage } from '../shared/environments.ts'
import type { EnvCheckResult, EnvLogEvent, EnvService, EnvUpResult, EnvUpStep, EnvVmState, EnvironmentInfo, EnvironmentSettings } from '../shared/types.ts'
import { splitComposeFiles, type Tools } from './tools.ts'

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
  /** `compose down -v` first in the registry's worktree where the host lets it run (a project's worktree inside the allowed paths; else the log says it was skipped), then the VM and its entry */
  destroy(profile: string, onLog: EnvLog): Promise<number>
  ps(profile: string, worktreePath: string, composeFile: string | undefined): Promise<EnvService[]>
  composeFiles(worktreePath: string): Promise<string[]>
  logs(profile: string, worktreePath: string, composeFile: string | undefined, service: string, tail: number): Promise<string>
  /** Whether the registry knows the profile */
  known(profile: string): Promise<boolean>
  /** Whether the registry has any VM of the repository (`repoKey`, envRepoKey's); an unreadable registry throws, as `list` does */
  knownRepo(repoKey: string): Promise<boolean>
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
  /**
   * The registry's JSON file (`<dataDir>/plugins/env/environments.json`, data.ts). It comes from
   * host.dataFile, which makes the plugin's data directory 0700 (mkdir and chmod); the file is 0600.
   */
  registryFile: string
  /** colima and docker, through the host */
  tools: Tools
  /** For tests: how long compose down may take in a destroy; default 60 s */
  composeDownTimeoutMs?: number
  /** VMs mount only this directory by default (Colima's $HOME); the worktree must be under it */
  home?: string
  /**
   * Other registries on this machine, read only (never written) by `list`: a twb- VM one of them
   * names is another Trek's (the other Local profile's), not an orphan to delete. Asked on each list.
   */
  otherRegistryFiles?: () => string[]
}

/** Tagged `reason: 'registry'`: the server's TOOL_ERROR carries it as `details.reason`, which the client shows. */
function registryUnreadable(registryFile: string, why: string): Error {
  return Object.assign(new Error(registryUnreadableMessage(registryFile, why)), { reason: REGISTRY_REASON })
}

export function createEnvironmentService(options: EnvironmentServiceOptions): EnvironmentService {
  const { registryFile, tools } = options
  const home = options.home ?? homedir()
  const composeDownTimeoutMs = options.composeDownTimeoutMs ?? 60_000

  /**
   * No file is an empty registry. Any other failure to read or parse it throws when `strict` (a
   * change, which must not write an empty registry over the entries it could not read, and
   * `list`, which would show every VM as an orphan to delete); the other reads take it as empty.
   */
  const readRegistry = async (strict = false): Promise<Registry> => {
    let text: string
    try {
      text = await readFile(registryFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || !strict) return {}
      throw registryUnreadable(registryFile, (err as Error).message)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      if (!strict) return {}
      // Never the parser's message: it can quote the file, and with it a branch's variables (secrets).
      throw registryUnreadable(registryFile, 'it does not parse')
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Registry
    if (!strict) return {}
    throw registryUnreadable(registryFile, 'it is not a JSON object')
  }
  // Write-then-rename (writeFileAtomic): a crash mid-write must not leave a torn file, which would
  // read as no VMs; 0600, a branch's variables may hold secrets, past a temp file a crash left behind.
  const writeRegistry = async (registry: Registry): Promise<void> => {
    writeFileAtomic(registryFile, JSON.stringify(registry, null, 2), 0o600)
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

  /** The profiles the other registries name; one that cannot be read or parsed names none. */
  const otherProfiles = async (): Promise<Set<string>> => {
    const names = new Set<string>()
    for (const file of options.otherRegistryFiles?.() ?? []) {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const name of Object.keys(parsed)) names.add(name)
      } catch {
        // missing, unreadable or torn: its VMs show as orphans, as they would with no sibling
      }
    }
    return names
  }

  let toolCheck: EnvCheckResult | null = null

  return {
    async check() {
      if (toolCheck?.ok) return toolCheck
      toolCheck = await tools.checkTools()
      return toolCheck
    },

    async known(profile) {
      return entryOf(await readRegistry(), profile) !== undefined
    },

    async knownRepo(repoKey) {
      return Object.values(await readRegistry(true)).some((entry) => entry?.repoPath === repoKey)
    },

    async list(repoKey) {
      // Strict: an unreadable registry would list every VM as an orphan to delete.
      const [registry, profiles] = await Promise.all([readRegistry(true), tools.listColimaProfiles()])
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
      // twb- VMs with no registry entry (crash leftovers): surfaced for cleanup. A VM another
      // registry on this machine names is that one's, and not listed.
      const others = await otherProfiles()
      for (const vm of profiles) {
        if (!vm.name.startsWith(ENV_PROFILE_PREFIX) || entryOf(registry, vm.name) || others.has(vm.name)) continue
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
        const vmCode = await tools.startVm(
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
        const composeCode = await tools.composeUp(profile, worktreePath, composeFile, log.onData, envVars)
        if (composeCode !== 0) return fail(`docker compose up exited with code ${composeCode}`)

        log.step('ready')
        let address: string | undefined
        try {
          address = (await tools.listColimaProfiles()).find((p) => p.name === profile)?.address
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
        const code = await tools.stopVm(profile, log.onData)
        log.finish(`[colima stop exited with code ${code}]\n`)
        return code
      })
    },

    destroy(profile, onLog) {
      const log = logSender(profile, onLog)
      return enqueue(profile, async () => {
        // Belt-and-braces for bind-mount cleanup; the volumes die with the VM anyway, so a failure
        // (VM stopped, compose file gone, a minute gone by) is fine. The host runs compose only in a
        // project's worktree inside the server's allowed paths; anywhere else it is skipped.
        const entry = entryOf(await readRegistry(), profile)
        if (entry && (await exists(entry.worktreePath))) {
          const composeFile = entry.composeFile || ENV_DEFAULTS.composeFile
          const signal = AbortSignal.timeout(composeDownTimeoutMs)
          await tools.composeDownVolumes(profile, entry.worktreePath, composeFile, log.onData, entry.envVars, {
            signal,
            refused: (why) => log.onData(`skipping docker compose down: ${why}\n`)
          })
          if (signal.aborted) log.onData(`docker compose down timed out after ${composeDownTimeoutMs / 1000} s; deleting the VM anyway\n`)
        }
        const code = await tools.deleteVm(profile, log.onData)
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
      return tools.composePs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, entry?.envVars)
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
      return tools.composeLogs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, service, tail, entry?.envVars)
    }
  }
}
