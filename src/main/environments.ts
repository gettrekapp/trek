import { app, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
} from '../host/colimaService'
import { ENV_DEFAULTS, ENV_PROFILE_PREFIX, deriveProfileName } from '../shared/environments'
import type {
  EnvCheckResult,
  EnvService,
  EnvUpResult,
  EnvUpStep,
  EnvVmState,
  EnvironmentInfo,
  EnvironmentSettings
} from '../shared/types'

/**
 * VMs are machine state, not project state — the registry lives in userData
 * and maps each profile back to the repo/branch/worktree that owns it, which
 * is what makes orphan detection possible (profile names hash, they don't
 * invert).
 */
interface RegistryEntry {
  repoPath: string
  branch: string
  worktreePath: string
  composeFile?: string
  /** Extra env for docker compose (variable substitution), from the Env tab */
  envVars?: Record<string, string>
  createdAt: string
}

type Registry = Record<string, RegistryEntry>

function registryFile(): string {
  return join(app.getPath('userData'), 'environments.json')
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(registryFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Registry) : {}
  } catch {
    return {}
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await writeFile(registryFile(), JSON.stringify(registry, null, 2), 'utf8')
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

function assertLocal(serverId: string | null): void {
  if (serverId != null) throw new Error('Remote environments are not supported yet')
}

/** Serialize operations per profile so double-clicks can't race two colima runs. */
const opQueues = new Map<string, Promise<unknown>>()
function enqueue<T>(profile: string, work: () => Promise<T>): Promise<T> {
  const prev = opQueues.get(profile) ?? Promise.resolve()
  const next = prev.then(work, work)
  opQueues.set(profile, next)
  return next
}

function makeLogSender(sender: WebContents, profile: string): {
  onData: (data: string) => void
  finish: (data: string) => void
  step: (step: EnvUpStep) => void
  tail: () => string
} {
  let tail = ''
  const send = (data: string, done?: boolean, step?: EnvUpStep): void => {
    tail = (tail + data).slice(-8_192)
    if (!sender.isDestroyed()) sender.send('env:log', { profile, data, done, step })
  }
  return {
    onData: (data) => send(data),
    finish: (data) => send(data, true),
    step: (step) => send('', false, step),
    tail: () => tail
  }
}

/** colima start failed because the vmnet sudo helper isn't installed yet. */
const isSudoHelperFailure = (output: string): boolean =>
  /sudo|vmnet|password/i.test(output)

export function registerEnvironmentHandlers(): void {
  let toolCheck: EnvCheckResult | null = null

  ipcMain.handle('env:check', async (): Promise<EnvCheckResult> => {
    if (toolCheck?.ok) return toolCheck
    toolCheck = await checkTools()
    return toolCheck
  })

  ipcMain.handle(
    'env:list',
    async (_event, serverId: string | null, repoPath: string): Promise<EnvironmentInfo[]> => {
      assertLocal(serverId)
      const [registry, profiles] = await Promise.all([readRegistry(), listColimaProfiles()])
      const byName = new Map(profiles.map((p) => [p.name, p]))
      const infos: EnvironmentInfo[] = []

      for (const [profile, entry] of Object.entries(registry)) {
        if (entry.repoPath !== repoPath) continue
        const vm = byName.get(profile)
        const vmState: EnvVmState =
          vm == null ? 'missing' : vm.status === 'Running' ? 'running' : 'stopped'
        infos.push({
          profile,
          ...entry,
          vmState,
          address: vm?.address,
          orphaned: (await exists(entry.worktreePath)) ? undefined : true
        })
      }

      // twb- VMs with no registry entry (crash leftovers) — surface for cleanup.
      for (const vm of profiles) {
        if (!vm.name.startsWith(ENV_PROFILE_PREFIX) || registry[vm.name]) continue
        infos.push({
          profile: vm.name,
          repoPath,
          branch: '',
          worktreePath: '',
          vmState: vm.status === 'Running' ? 'running' : 'stopped',
          address: vm.address,
          orphaned: true
        })
      }
      return infos
    }
  )

  ipcMain.handle(
    'env:up',
    (
      event,
      serverId: string | null,
      repoPath: string,
      branch: string,
      worktreePath: string,
      settings: EnvironmentSettings | undefined,
      envVars: Record<string, string> | undefined
    ): Promise<EnvUpResult> => {
      assertLocal(serverId)
      const profile = deriveProfileName(repoPath, branch)
      const log = makeLogSender(event.sender, profile)
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
        if (!worktreePath.startsWith(homedir())) {
          return fail(
            `Worktree is outside your home directory (${worktreePath}) — Colima only mounts $HOME by default`
          )
        }

        // Registered before starting so a crash mid-boot still leaves a trail.
        const registry = await readRegistry()
        registry[profile] = {
          repoPath,
          branch,
          worktreePath,
          composeFile,
          envVars: envVars && Object.keys(envVars).length > 0 ? envVars : undefined,
          createdAt: registry[profile]?.createdAt ?? new Date().toISOString()
        }
        await writeRegistry(registry)

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
              `Colima's network helper needs a one-time sudo install. Run "colima start ${profile} --network-address" in a terminal once, or disable "Per-VM IP address" in Settings.`
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
          // non-fatal — the env:list poll will pick the address up
        }
        log.finish('[environment ready]\n')
        return { code: 0, address }
      })
    }
  )

  ipcMain.handle(
    'env:stop',
    (event, serverId: string | null, profile: string): Promise<number> => {
      assertLocal(serverId)
      const log = makeLogSender(event.sender, profile)
      return enqueue(profile, async () => {
        const code = await stopVm(profile, log.onData)
        log.finish(`[colima stop exited with code ${code}]\n`)
        return code
      })
    }
  )

  ipcMain.handle(
    'env:destroy',
    (event, serverId: string | null, profile: string): Promise<number> => {
      assertLocal(serverId)
      const log = makeLogSender(event.sender, profile)
      return enqueue(profile, async () => {
        // Belt-and-braces for bind-mount cleanup; the volumes die with the VM
        // anyway, so a failure (VM stopped, compose file gone) is fine.
        const registry = await readRegistry()
        const entry = registry[profile]
        if (entry && (await exists(entry.worktreePath))) {
          const composeFile = entry.composeFile || ENV_DEFAULTS.composeFile
          await Promise.race([
            composeDownVolumes(profile, entry.worktreePath, composeFile, log.onData, entry.envVars),
            new Promise((resolve) => setTimeout(resolve, 60_000, -1))
          ]).catch(() => -1)
        }
        const code = await deleteVm(profile, log.onData)
        delete registry[profile]
        await writeRegistry(registry)
        log.finish(`[environment destroyed]\n`)
        return code
      })
    }
  )

  ipcMain.handle(
    'env:ps',
    async (
      _event,
      serverId: string | null,
      profile: string,
      worktreePath: string,
      composeFile: string | undefined
    ): Promise<EnvService[]> => {
      assertLocal(serverId)
      const entry = (await readRegistry())[profile]
      return composePs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, entry?.envVars)
    }
  )

  // Compose file candidates in the worktree root, for the Apply-compose picker.
  ipcMain.handle(
    'env:composeFiles',
    async (_event, serverId: string | null, worktreePath: string): Promise<string[]> => {
      assertLocal(serverId)
      try {
        const entries = await readdir(worktreePath)
        return entries
          .filter((f) => /^(docker-)?compose([.-][^.]+)*\.(yml|yaml)$/i.test(f))
          .sort((a, b) => a.length - b.length || a.localeCompare(b))
      } catch {
        return []
      }
    }
  )

  ipcMain.handle(
    'env:logs',
    async (
      _event,
      serverId: string | null,
      profile: string,
      worktreePath: string,
      composeFile: string | undefined,
      service: string,
      tail: number | undefined
    ): Promise<string> => {
      assertLocal(serverId)
      const entry = (await readRegistry())[profile]
      return composeLogs(
        profile,
        worktreePath,
        composeFile || ENV_DEFAULTS.composeFile,
        service,
        tail ?? 300,
        entry?.envVars
      )
    }
  )
}
