// The Local server supervisor's decisions (localServer.ts), pure: which profile this
// build uses and where its files are, whether what local.json names can be used, version skew against the
// bundle, the child's env, what a failed start means, what a restart does once
// `stop --local` has answered, and when "Reset local server" may delete the lock.
import { join } from 'node:path'
import {
  LOCAL_CONFIG_FILE,
  LOCAL_INFO_FILE,
  LOCAL_LOCK_FILE,
  LOCAL_ALREADY_RUNNING_EXIT,
  localProfileDir,
  type LocalInfo
} from '../shared/localServer.ts'

/** The synthetic app-server entry's id: recents and open-windows.json are keyed by it. */
export const LOCAL_ENTRY_ID = 'local'
export const LOCAL_ENTRY_NAME = 'Local'
/** The server's stdout and stderr, in the profile beside local.json */
export const LOCAL_LOG_FILE = 'server.log'
/** A spawn moves a log past this size to server.log.old first */
export const LOG_ROTATE_BYTES = 1024 * 1024
/** How long a spawn waits for local.json (Notes for 4b, 14) */
export const READY_TIMEOUT_MS = 15_000
/** After an exit 3, how long the winner of the lock has to write local.json (Notes for 4b, 9) */
export const LOST_RACE_WAIT_MS = 8_000
/** A hello to what local.json names gives up after this */
export const PROBE_TIMEOUT_MS = 3_000

export interface LocalPaths {
  dir: string
  config: string
  info: string
  lock: string
  log: string
}

/** The local profile a dev build (not packaged) uses, so it never restarts the installed Trek's server. */
export const DEV_LOCAL_PROFILE = 'dev'

/**
 * The local profile this Trek uses: the default one (undefined) when packaged,
 * `dev` (~/.config/trek-server/local-dev) for `npm run dev` and the smokes. An
 * installed Trek and a dev build would otherwise share one server, and each would
 * offer to restart the other's, ending its sessions.
 */
export function localProfileName(isPackaged: boolean): string | undefined {
  return isPackaged ? undefined : DEV_LOCAL_PROFILE
}

/** The CLI arguments that select `profile`, after `start --local` or `stop --local`. */
export function localProfileArgs(profile: string | undefined): string[] {
  return profile === undefined ? [] : ['--local-profile', profile]
}

/** The profile's files; `profile` is localProfileName's (throws on an invalid name). */
export function localPaths(home: string, profile?: string): LocalPaths {
  const dir = join(home, ...localProfileDir(profile))
  return {
    dir,
    config: join(dir, LOCAL_CONFIG_FILE),
    info: join(dir, LOCAL_INFO_FILE),
    lock: join(dir, LOCAL_LOCK_FILE),
    log: join(dir, LOCAL_LOG_FILE)
  }
}

/** The local server binds loopback only. */
export function localUrl(port: number): string {
  return `ws://127.0.0.1:${port}`
}

/** out/server/build.json, as server/scripts/build.mjs writes it */
export interface BundledBuild {
  version: string
  build: string
}

const BUILD_RE = /^([0-9a-f]{12}|dev)$/

export function parseBuildJson(raw: unknown): BundledBuild | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { version, build } = raw as Record<string, unknown>
  if (typeof version !== 'string' || version === '' || typeof build !== 'string' || !BUILD_RE.test(build)) return undefined
  return { version, build }
}

export interface ProbeFacts {
  /** local.json through parseLocalInfo; undefined if missing or refused */
  info: LocalInfo | undefined
  /** Its pid answers signal 0 */
  alive: boolean
  /** The welcome to a hello with its token, if one came */
  welcome: { capabilities: readonly string[]; serverId: string } | undefined
  /** The profile's config.json serverId, if it has one yet */
  expectedServerId?: string
}

export type ProbeVerdict = { use: true } | { use: false; why: string }

/**
 * Use what local.json names only if its pid lives and a hello with its token is
 * welcomed with the `local` capability and this profile's serverId. Anything else
 * means spawn: the new start's lock decides whether it runs (a dead holder is
 * taken over) or exits 3 (a live one).
 */
export function probeVerdict(f: ProbeFacts): ProbeVerdict {
  if (!f.info) return { use: false, why: 'no local.json' }
  if (!f.alive) return { use: false, why: `pid ${f.info.pid} is gone` }
  if (!f.welcome) return { use: false, why: `pid ${f.info.pid} does not answer on port ${f.info.port}` }
  if (!f.welcome.capabilities.includes('local')) return { use: false, why: `the server on port ${f.info.port} is not a local server` }
  if (f.expectedServerId && f.welcome.serverId !== f.expectedServerId) {
    return { use: false, why: `the server on port ${f.info.port} is another profile (${f.welcome.serverId})` }
  }
  return { use: true }
}

/** -1, 0 or 1, comparing dotted numbers part by part; a part that is not a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export interface Skew {
  /** The running server against the bundled one */
  relation: 'older' | 'newer' | 'other-build'
  /** "0.1.0 (ffffffffffff)" */
  running: string
  bundled: string
}

/** The running server is not the bundled one: another version, or the same version from another build. */
export function skewOf(bundled: BundledBuild | undefined, running: Pick<LocalInfo, 'version' | 'build'>): Skew | null {
  if (!bundled) return null
  if (bundled.version === running.version && bundled.build === running.build) return null
  const cmp = compareVersions(running.version, bundled.version)
  return {
    relation: cmp < 0 ? 'older' : cmp > 0 ? 'newer' : 'other-build',
    running: `${running.version} (${running.build})`,
    bundled: `${bundled.version} (${bundled.build})`
  }
}

/** Variables the server and its agents must not inherit from the app (Notes for 4b, 11). */
const DROPPED_PREFIXES = ['ELECTRON_', 'TREK_']
const DROPPED = new Set(['NODE_OPTIONS', 'NODE_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])

/**
 * The spawned server's env: the app's (PATH already fixed by fixPath), without
 * Electron's and the dev server's variables, a Trek session's own (a dev app run
 * from a Trek terminal carries TREK_MCP_TOKEN), Node's options, or a git
 * location; plus ELECTRON_RUN_AS_NODE, which the server deletes from its own env
 * before any pty is spawned.
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROPPED.has(key) || DROPPED_PREFIXES.some((p) => key.startsWith(p))) continue
    out[key] = value
  }
  out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

export type SpawnFailure = { kind: 'lock-held' } | { kind: 'lock-error'; message: string } | { kind: 'exited'; message: string }

/** A spawned start that exited before writing local.json (Notes for 4b, 9 and 10). */
export function spawnFailure(code: number | string, log: string): SpawnFailure {
  if (code === LOCAL_ALREADY_RUNNING_EXIT) return { kind: 'lock-held' }
  const lockLine = log.split('\n').find((l) => l.startsWith('Cannot take the lock '))
  if (code === 1 && lockLine) return { kind: 'lock-error', message: lockLine.trim() }
  return { kind: 'exited', message: `The local server exited with ${typeof code === 'number' ? `code ${code}` : code}` }
}

export interface StopFacts {
  /** `stop --local`'s exit code */
  code: number | null
  /** The pid the restart set out to stop */
  target: number
  /** local.lock's pid and local.json's pid, read after the stop answered */
  lockPid: number | undefined
  infoPid: number | undefined
  /** `target` answers signal 0 */
  alive: boolean
}

/**
 * After `stop --local` (Notes for 4b, 13): exit 0, or the target gone, means spawn.
 * Exit 1 with the target alive means SIGKILL, but only if the lock and local.json
 * both still name it; anything else is reported and nothing is signalled.
 */
export function afterStop(f: StopFacts): 'spawn' | 'sigkill' | 'refuse' {
  if (f.code === 0 || !f.alive) return 'spawn'
  if (f.code === 1 && f.lockPid === f.target && f.infoPid === f.target) return 'sigkill'
  return 'refuse'
}

export interface ResetFacts {
  /** local.lock's pid, if there is a lock */
  lockPid: number | undefined
  lockAlive: boolean
  /** How long ago the lock was written (its mtime) */
  lockAgeMs: number
  info: LocalInfo | undefined
  /** A hello with local.json's token was welcomed as a local server */
  welcomed: boolean
  /** local.json's port takes a TCP connection */
  portOpen: boolean
}

/**
 * "Reset local server" (Notes for 4b, 6 and 16). The lock is deleted only when no
 * process that could be our server holds it:
 * - a welcome: the server is live, connect to it;
 * - no lock: nothing to reset, start;
 * - a live pid's lock younger than READY_TIMEOUT_MS: a start still on its way to
 *   local.json (it deletes the old one first). Refuse;
 * - the lock's pid dead, or alive but not the pid local.json names (or there is no
 *   local.json): a reused pid, reset;
 * - alive and named by local.json, but its port refuses connections: a SIGKILLed
 *   server's pid reused (a live server listens before it writes local.json), reset;
 * - alive, named by local.json, its port open, no welcome: possibly our server,
 *   hung. Refuse: deleting its lock would let a second server share its files.
 */
export function resetDecision(f: ResetFacts): 'start' | 'connect' | 'reset' | 'refuse' {
  if (f.welcomed) return 'connect'
  if (f.lockPid === undefined) return 'start'
  if (!f.lockAlive) return 'reset'
  if (f.lockAgeMs < READY_TIMEOUT_MS) return 'refuse'
  if (!f.info || f.info.pid !== f.lockPid) return 'reset'
  return f.portOpen ? 'refuse' : 'reset'
}

/** The last `lines` non-empty lines of a log, for an error dialog. */
export function logTail(text: string, lines = 20): string {
  return text.split('\n').filter((l) => l.trim() !== '').slice(-lines).join('\n')
}
