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
  isLocalProfileName,
  localProfilePath,
  type LocalInfo
} from '../shared/localServer.ts'
import type { LocalServerStatus } from '../shared/types.ts'

/** The synthetic app-server entry's id (shared, so the renderer uses the same one). */
export { LOCAL_ENTRY_ID } from '../shared/appServerRules.ts'
export const LOCAL_ENTRY_NAME = 'Local'
/** The server's stdout and stderr, in the profile beside local.json */
export const LOCAL_LOG_FILE = 'server.log'
/** A spawn, or adopting a running server, moves a log past this size to server.log.old first */
export const LOG_ROTATE_BYTES = 1024 * 1024
/** How long a spawn waits for local.json (Notes for 4b, 14) */
export const READY_TIMEOUT_MS = 15_000
/** After an exit 3, the least time the winner of the lock is still given to answer (lostRaceDeadline) */
export const LOST_RACE_MIN_WAIT_MS = 2_000
/** A hello to what local.json names gives up after this */
export const PROBE_TIMEOUT_MS = 3_000

/** Set by the smokes that test other things: no Local server, entry or menu. */
export const NO_LOCAL_SERVER_ENV = 'TREK_NO_LOCAL_SERVER'

/** TREK_NO_LOCAL_SERVER is on only as `1`, `true` or `yes` (any case, spaces trimmed); unset, `0`, `` or anything else is off. */
export function localServerDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return ['1', 'true', 'yes'].includes((env[NO_LOCAL_SERVER_ENV] ?? '').trim().toLowerCase())
}

/**
 * After an exit 3 (another start holds the lock, Notes for 4b, 9): when to stop waiting
 * for the winner's server to answer. The winner has READY_TIMEOUT_MS from taking the lock
 * (the lock's mtime), the same span before which Reset refuses a live holder's lock, so
 * the loser waits until then, and at least LOST_RACE_MIN_WAIT_MS. No lock read (it went,
 * or did not parse): READY_TIMEOUT_MS from now. A lock dated in the future counts as now.
 */
export function lostRaceDeadline(now: number, lockMtimeMs: number | undefined): number {
  if (lockMtimeMs === undefined || !Number.isFinite(lockMtimeMs)) return now + READY_TIMEOUT_MS
  return Math.max(Math.min(lockMtimeMs, now) + READY_TIMEOUT_MS, now + LOST_RACE_MIN_WAIT_MS)
}

/** What a failed job set out to do: the error's title and status line say which. */
export type LocalOp = NonNullable<LocalServerStatus['failed']>

/**
 * A failed job keeps the server main is using only when it was a stop or a restart
 * (a start had none to keep) and local.json still names that same server (pid, port,
 * token) with its pid alive: the windows stay connected to a server that still runs.
 */
export function keepAfterFailure(f: {
  op: LocalOp
  current: Pick<LocalInfo, 'pid' | 'port' | 'token'> | null
  info: Pick<LocalInfo, 'pid' | 'port' | 'token'> | undefined
  alive: boolean
}): boolean {
  if (f.op === 'start' || !f.current || !f.info || !f.alive) return false
  return f.info.pid === f.current.pid && f.info.port === f.current.port && f.info.token === f.current.token
}

export interface LocalPaths {
  dir: string
  config: string
  info: string
  lock: string
  log: string
}

/** The local profile a dev build (not packaged) uses, so it never restarts the installed Trek's server. */
export const DEV_LOCAL_PROFILE = 'dev'

/** A dev build's own profile name instead of `dev`, e.g. `dev-wt2`, so worktrees do not share local-dev */
export const LOCAL_PROFILE_ENV = 'TREK_LOCAL_PROFILE'

/**
 * The local profile this Trek uses: the default one (undefined) when packaged,
 * `dev` (~/.config/trek-server/local-dev) for `npm run dev` and the smokes. An
 * installed Trek and a dev build would otherwise share one server, and each would
 * offer to restart the other's, ending its sessions.
 *
 * A dev build takes TREK_LOCAL_PROFILE instead when it is a valid profile name
 * (`dev-wt2` is ~/.config/trek-server/local-dev-wt2), so dev runs from several
 * worktrees each get their own server; an invalid one is ignored (`dev`). A packaged
 * build ignores it: a stray variable must never hide the installed app's projects.
 */
export function localProfileName(isPackaged: boolean, env: Readonly<Record<string, string | undefined>> = {}): string | undefined {
  if (isPackaged) return undefined
  const named = env[LOCAL_PROFILE_ENV]
  return isLocalProfileName(named) ? named : DEV_LOCAL_PROFILE
}

/**
 * The CLI arguments that select `profile`, after `start --local` or `stop --local`.
 * Throws on an invalid name, as localPaths does (localProfileName never returns one).
 */
export function localProfileArgs(profile: string | undefined): string[] {
  if (profile === undefined) return []
  if (!isLocalProfileName(profile)) throw new Error(`Invalid local profile name: ${JSON.stringify(profile)}`)
  return ['--local-profile', profile]
}

/**
 * The command line (`ps -o command=`) is a local server of `profile`: it mentions
 * trek-server (the bundle's trek-server.cjs, or an installed trek-server bin), has
 * `start --local`, and has `--local-profile <profile>` for a named profile or no
 * `--local-profile` for the default one. Errs towards "a server": that only ever
 * refuses a Reset or a SIGKILL.
 */
export function isLocalServerCommand(command: string, profile: string | undefined): boolean {
  if (!command.includes('trek-server') || !/(^|\s)start\s+--local(\s|$)/.test(command)) return false
  const named = /(^|\s)--local-profile\s+(\S+)/.exec(command)?.[2]
  return named === profile
}

/** The profile's files; `profile` is localProfileName's (throws on an invalid name). */
export function localPaths(home: string, profile?: string, platform: string = process.platform, env: Record<string, string | undefined> = process.env): LocalPaths {
  const dir = localProfilePath(join, platform, env, home, profile)
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

/**
 * Variables the server and its agents must not inherit from the app (Notes for 4b, 11).
 * Matched case-sensitively, and a prefix includes its underscore: `ELECTRON`, `trek_x`
 * and `NPM_TOKEN` are kept.
 */
const DROPPED_PREFIXES = ['ELECTRON_', 'TREK_', 'npm_']
/**
 * Kept despite their prefix: the server's test endpoints for Linear and ElevenLabs (the voice
 * plugin's, read through its host's testEndpoint; the smokes' stubs; the server takes them only on
 * loopback), and its gh (the smokes' stub, scripts/smokeGh.mjs).
 */
const KEPT = new Set(['TREK_SERVER_LINEAR_URL', 'TREK_SERVER_ELEVENLABS_URL', 'TREK_SERVER_GH'])
const DROPPED = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_ENV',
  'NODE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  // electron-vite dev and the npm script that ran it
  'NODE_ENV_ELECTRON_VITE',
  'NO_SANDBOX',
  'REMOTE_DEBUGGING_PORT',
  'INIT_CWD'
])

/**
 * The spawned server's env: the app's (PATH already fixed by fixPath), without
 * Electron's and the dev server's variables, npm's (`npm run dev`), a Trek
 * session's own (a dev app run from a Trek terminal carries TREK_MCP_TOKEN),
 * Node's options, or a git location; plus ELECTRON_RUN_AS_NODE, which the server
 * deletes from its own env before any pty is spawned. `env` is not changed.
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROPPED.has(key) || (!KEPT.has(key) && DROPPED_PREFIXES.some((p) => key.startsWith(p)))) continue
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
  /** `target`'s command line is this profile's server (isLocalServerCommand); undefined if `ps` could not tell */
  holderIsServer: boolean | undefined
}

/**
 * After `stop --local` (Notes for 4b, 13): exit 0 (it stopped, or its files are gone
 * and it is on its way out), or the target gone, means spawn. Exit 1 with the target
 * alive means SIGKILL, but only if the lock and local.json both still name it and its
 * command line is this profile's server; anything else is reported and nothing is
 * signalled.
 */
export function afterStop(f: StopFacts): 'spawn' | 'sigkill' | 'refuse' {
  if (f.code === 0 || !f.alive) return 'spawn'
  if (f.code === 1 && f.lockPid === f.target && f.infoPid === f.target && f.holderIsServer === true) return 'sigkill'
  return 'refuse'
}

export interface ResetFacts {
  /** local.lock's pid, if there is a lock */
  lockPid: number | undefined
  lockAlive: boolean
  /** How long ago the lock was written (its mtime) */
  lockAgeMs: number
  info: LocalInfo | undefined
  /** probeVerdict, with the profile's serverId, says use what local.json names */
  welcomed: boolean
  /** A TCP connection to local.json's port got ECONNREFUSED; a timeout or any other error is not a refusal */
  portRefused: boolean
  /** The lock's pid's command line is this profile's server (isLocalServerCommand); undefined if `ps` could not tell */
  holderIsServer: boolean | undefined
}

/**
 * "Reset local server" (Notes for 4b, 6 and 16). The lock is deleted only when no
 * process that could be our server holds it:
 * - a welcome (probeVerdict says use): the server is live, connect to it;
 * - no lock: nothing to reset, start;
 * - the lock's pid dead: reset (a start would take it over anyway);
 * - a live pid's lock younger than READY_TIMEOUT_MS (or dated in the future): a
 *   start still on its way to local.json (it deletes the old one first). Refuse;
 * - a live pid whose command line is this profile's server, or that `ps` could not
 *   read: refuse. It is our server, hung or still starting;
 * - alive, not a server, and not the pid local.json names (or there is no
 *   local.json): a reused pid, reset;
 * - alive, not a server, named by local.json: reset only if its port refuses
 *   connections (a SIGKILLed server's pid reused; a live server listens before it
 *   writes local.json). A timeout or an open port refuses: deleting a live server's
 *   lock would let a second server share its files.
 */
export function resetDecision(f: ResetFacts): 'start' | 'connect' | 'reset' | 'refuse' {
  if (f.welcomed) return 'connect'
  if (f.lockPid === undefined) return 'start'
  if (!f.lockAlive) return 'reset'
  if (!(f.lockAgeMs >= READY_TIMEOUT_MS)) return 'refuse'
  if (f.holderIsServer !== false) return 'refuse'
  if (!f.info || f.info.pid !== f.lockPid) return 'reset'
  return f.portRefused ? 'reset' : 'refuse'
}

/** A lock file's identity, from (l)stat */
export interface FileId {
  dev: number
  ino: number
  ctimeMs: number
}

/**
 * The same file: device, inode and ctime (part of the server's localLock.ts sameLock). Reset
 * unlinks the lock only if it is still the one it judged, not one a start wrote meanwhile:
 * this and the same pid and nonce (a filesystem may give the new file the old one's inode and ctime).
 */
export function sameFile(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs
}

/** The last `lines` non-empty lines of a log, for an error dialog (CRLF read as LF). */
export function logTail(text: string, lines = 20): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-lines).join('\n')
}
