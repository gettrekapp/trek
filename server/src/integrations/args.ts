// Argument checks for the docker, env and stack methods (phase 5a). A client on another machine can
// call these, so every value that reaches a command line or a process environment is checked here:
// nothing goes through a shell (every command is execFile or spawn with an argument list), and each
// value is limited to what the method needs. Every failure is BAD_REQUEST.
import { isAbsolute, relative, resolve } from 'node:path'
import { ENV_PROFILE_PREFIX } from '../../../src/shared/environments.ts'
import type { ComposeAction, ContainerAction, EnvironmentSettings } from '../../../src/shared/types'
import { codedError } from '../errors.ts'
import { isRecord, requireString } from '../validate.ts'
import { realPath } from '../../../src/host/pathContainment.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** A twb- Colima profile, as deriveProfileName makes them (and as `colima list` lists the leftovers). */
const PROFILE_RE = new RegExp(`^${ENV_PROFILE_PREFIX}[a-z0-9][a-z0-9-]{0,62}$`)
/** A container id or name, as `docker ps` prints them. Never a leading "-": that would be a flag. */
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
/** A compose service name. */
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
/** A variable name, as parseEnvVars reads them. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * Variables a branch's list may not set, in any case: they would change which programs docker
 * compose runs, where it connects or which files it reads as its own configuration (the run is
 * pinned to the VM's own context), not what the compose file reads. PATH, HOME, XDG_CONFIG_HOME
 * and the DOCKER_*, COMPOSE_*, BUILDKIT_*, LD_* and DYLD_* families.
 */
const DENIED_ENV = /^(PATH|HOME|XDG_CONFIG_HOME|DOCKER_.*|COMPOSE_.*|BUILDKIT_.*|LD_.*|DYLD_.*)$/i
const DENIED_ENV_NAMES = 'PATH, HOME, XDG_CONFIG_HOME, DOCKER_*, COMPOSE_*, BUILDKIT_*, LD_* and DYLD_*'
const MAX_ENV_VARS = 200
const MAX_ENV_VALUE = 32 * 1024
const MAX_COMPOSE_FILE = 1024

export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['start', 'stop', 'restart']
export const COMPOSE_ACTIONS: readonly ComposeAction[] = ['up', 'upBuild', 'restart', 'stop', 'down', 'pull']

export function requireProfile(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_RE.test(value)) throw bad(`profile must be a ${ENV_PROFILE_PREFIX} environment name`)
  return value
}

export function requireContainerId(value: unknown): string {
  if (typeof value !== 'string' || !CONTAINER_RE.test(value)) throw bad('id must be a container id or name')
  return value
}

export function requireContainerAction(value: unknown): ContainerAction {
  if (!(CONTAINER_ACTIONS as readonly unknown[]).includes(value)) throw bad(`action must be one of ${CONTAINER_ACTIONS.join(', ')}`)
  return value as ContainerAction
}

export function requireComposeAction(value: unknown): ComposeAction {
  if (!(COMPOSE_ACTIONS as readonly unknown[]).includes(value)) throw bad(`action must be one of ${COMPOSE_ACTIONS.join(', ')}`)
  return value as ComposeAction
}

export function requireService(value: unknown): string {
  if (typeof value !== 'string' || !SERVICE_RE.test(value)) throw bad('service must be a compose service name')
  return value
}

/** An integer in [min, max], or `fallback` when absent. */
export function optionalInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  return requireInt(value, field, min, max)
}

export function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${field} must be an integer from ${min} to ${max}`)
  }
  return value
}

/** A finite number in [min, max]: colima's `--memory` takes GiB as a float (1.5). */
export function requireNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw bad(`${field} must be a number from ${min} to ${max}`)
  }
  return value
}

/**
 * A compose file setting: one or more comma-separated paths relative to the worktree, each inside
 * it. Not absolute, no "..", no leading "-" (it follows `-f`, but compose must never read a flag),
 * no NUL; and a file that exists must stay inside the worktree's real path once its symlinks are
 * followed. Undefined when absent or blank (the default file).
 */
export function optionalComposeFile(value: unknown, worktreePath: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > MAX_COMPOSE_FILE) throw bad('composeFile must be a string')
  const files = value
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (files.length === 0) return undefined
  const realWorktree = realOrNull(worktreePath) ?? worktreePath
  for (const file of files) {
    const inside = relative(worktreePath, resolve(worktreePath, file))
    if (
      file.includes('\0') ||
      file.startsWith('-') ||
      isAbsolute(file) ||
      file.split(/[\\/]/).includes('..') ||
      inside === '' ||
      inside.startsWith('..') ||
      isAbsolute(inside)
    ) {
      throw bad(`composeFile: ${JSON.stringify(file)} must be a file inside the worktree`)
    }
    const real = realOrNull(resolve(worktreePath, file))
    if (real !== null && !within(realWorktree, real)) throw bad(`composeFile: ${JSON.stringify(file)} leads outside the worktree (a symlink)`)
  }
  return files.join(',')
}

function realOrNull(path: string): string | null {
  try {
    return realPath(path)
  } catch {
    return null
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const SETTINGS_KEYS = ['enabled', 'cpu', 'memory', 'disk', 'networkAddress', 'rosetta', 'composeFile', 'profileKey'] as const

/**
 * An environment's settings for `env.up`: only the known keys, with sizes in range. `profileKey` is
 * accepted and dropped: the VM's name comes from the repository the server stores, never the client.
 */
export function requireEnvSettings(value: unknown, worktreePath: string): EnvironmentSettings {
  if (!isRecord(value)) throw bad('settings must be an object')
  for (const key of Object.keys(value)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) throw bad(`settings.${key} is not an environment setting`)
  }
  const bool = (key: 'enabled' | 'networkAddress' | 'rosetta'): boolean | undefined => {
    const v = value[key]
    if (v === undefined) return undefined
    if (typeof v !== 'boolean') throw bad(`settings.${key} must be a boolean`)
    return v
  }
  const settings: EnvironmentSettings = { enabled: bool('enabled') ?? true }
  const networkAddress = bool('networkAddress')
  const rosetta = bool('rosetta')
  if (networkAddress !== undefined) settings.networkAddress = networkAddress
  if (rosetta !== undefined) settings.rosetta = rosetta
  if (value.cpu !== undefined) settings.cpu = requireInt(value.cpu, 'settings.cpu', 1, 256)
  if (value.memory !== undefined) settings.memory = requireNumber(value.memory, 'settings.memory', 0.5, 1024)
  if (value.disk !== undefined) settings.disk = requireInt(value.disk, 'settings.disk', 1, 10_000)
  const composeFile = optionalComposeFile(value.composeFile, worktreePath)
  if (composeFile !== undefined) settings.composeFile = composeFile
  if (value.profileKey !== undefined && typeof value.profileKey !== 'string') throw bad('settings.profileKey must be a string')
  return settings
}

/** A branch's variables for docker compose: names as parseEnvVars reads them, string values, none that steer the run. */
export function optionalEnvVars(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw bad('envVars must be an object')
  const keys = Object.keys(value)
  if (keys.length > MAX_ENV_VARS) throw bad(`envVars may have at most ${MAX_ENV_VARS} variables`)
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) throw bad(`envVars: ${JSON.stringify(key)} is not a variable name`)
    if (DENIED_ENV.test(key)) throw bad(`envVars: ${key} cannot be set for docker compose (${DENIED_ENV_NAMES} are the server's)`)
    const v = value[key]
    if (typeof v !== 'string' || v.includes('\0') || v.length > MAX_ENV_VALUE) throw bad(`envVars.${key} must be a string`)
    out[key] = v
  }
  return keys.length > 0 ? out : undefined
}

export { requireString }
