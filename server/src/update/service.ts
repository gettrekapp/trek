// A running server's update state, for the protocol (update.status, update.check, update.apply)
// and its own daily check. It wraps the installer (apply.ts) with what a client needs to follow
// an update: one state at a time, a percent while downloading, and a change for every step.
// What it remembers across restarts is the state file (state.ts); whether a restart is pending is
// read from the install folder itself, so it is right whoever installed the new version.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateResultWire, UpdateStatus } from '../../../src/shared/protocolV2.ts'
import { compareVersions } from '../../../src/shared/versions.ts'
import { codedError } from '../errors.ts'
import type { ApplyResult, UpdateStep } from './apply.ts'
import type { Release } from './feed.ts'
import { readState } from './state.ts'
import type { Install } from './updatable.ts'

/** What `apply` is given: the version to expect, and where to report progress. */
export interface ServiceApplyOptions {
  expect: { version: string }
  onStep: (step: UpdateStep) => void
  onProgress: (bytes: number, total: number | undefined) => void
}

export interface UpdateServiceDeps {
  install: Install
  /** Where update-state.json is: the config file's folder */
  configDir: string
  /** The version this process is running */
  running: string
  /** Terminals running now */
  sessions: () => number
  /** The config's `updates.remoteApply` (true unless it is false), read at each request */
  remoteApply: () => boolean
  canRelaunch: () => boolean
  /** Why this server cannot be restarted into the install's launcher, or null */
  relaunchRefusal: () => string | null
  /** Reads the feed: the newer release, or null. Records the check (apply.ts findUpdate). */
  find: () => Promise<Release | null>
  /** Installs (apply.ts applyUpdate). */
  apply: (opts: ServiceApplyOptions) => Promise<ApplyResult>
  /** Restarts this server into the installed version; `version` is what clients are told */
  relaunch: (version: string) => void
  /** Every change of state, percent or outcome */
  onChange: (status: UpdateStatus) => void
  /** The time now (the tests' clock) */
  now?: () => Date
}

export interface UpdateService {
  /** Never throws */
  status(): UpdateStatus
  /**
   * Reads the feed and answers the status after it. Rejects (TOOL_ERROR) when the feed cannot be
   * read, (CONFLICT, reason `busy`) while an update runs. Asked within MIN_CHECK_INTERVAL_MS of
   * the last read, it does not read again: it answers the status as it is now, or rejects with
   * that read's error if it failed.
   */
  check(): Promise<UpdateStatus>
  /** Begins installing `version`. Throws CONFLICT (reason `disabled`, `busy` or `stale`) or BAD_REQUEST. */
  apply(version: unknown): { started: true }
  /** Settles when no check or install is running (for the tests and a clean shutdown). Never rejects. */
  idle(): Promise<void>
}

type State = UpdateStatus['state']

/**
 * The feed is read for a check at most once in this long, whoever asks (a client's
 * `update.check`, the daily check): each read is two requests to GitHub, a write of the state
 * file and two changes to every client, and any signed-in client can ask in a loop. A check
 * asked sooner is answered from the last read.
 */
export const MIN_CHECK_INTERVAL_MS = 30_000

const STEP_STATE: Record<UpdateStep, State> = {
  checking: 'checking',
  downloading: 'downloading',
  unpacking: 'installing',
  selfcheck: 'installing',
  installing: 'installing'
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The version in the install folder's build.json, or undefined when it cannot be read. */
export function installedVersion(dir: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
    const version = (raw as { version?: unknown } | null)?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** The state file's last result, if it is one: the file is the user's to edit, and the wire's types are a promise. */
function resultOf(raw: unknown): UpdateResultWire | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.ok !== 'boolean' || typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.at !== 'string') return undefined
  return { ok: r.ok, from: r.from, to: r.to, at: r.at, ...(typeof r.error === 'string' ? { error: r.error } : {}) }
}

/** `read()`, or `fallback` when it throws: nothing a status is made of may fail it. */
function careful<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  let state: State = 'idle'
  let percent: number | undefined
  let checking: Promise<UpdateStatus> | null = null
  let applying: Promise<void> | null = null
  /**
   * How the last install asked of this service failed, when the installer recorded nothing (the
   * update's lock was held: the update that holds it records its own) or something else (the
   * install succeeded and the restart could not begin). Kept in memory only, and only until a new
   * attempt starts or a check succeeds: it is about this process's last attempt, not the install.
   */
  let failure: UpdateResultWire | null = null
  /** When the last check's read of the feed began, and why it failed if it did */
  let lastRead: { at: number; error?: string } | null = null
  const now = (): Date => deps.now?.() ?? new Date()
  // `cause`: the reason alone, for the server's own log line.
  const checkFailed = (error: string): Error => Object.assign(codedError('TOOL_ERROR', `Could not check for an update: ${error}`), { cause: error })

  /** The last result to report: the state file's, or this service's own failure when that is the newer one. Never both. */
  const lastOf = (recorded: UpdateResultWire | undefined): UpdateResultWire | undefined => {
    if (!failure) return recorded
    if (!recorded) return failure
    // An unreadable time on record (the file is the user's to edit) is not newer than anything.
    return Date.parse(recorded.at) > Date.parse(failure.at) ? recorded : failure
  }

  const status = (): UpdateStatus => {
    const remembered: Record<string, unknown> = careful(() => ({ ...readState(deps.configDir) }), {})
    const latest = typeof remembered.latest === 'string' && compareVersions(remembered.latest, deps.running) > 0 ? remembered.latest : undefined
    const installed = installedVersion(deps.install.dir)
    const lastResult = lastOf(resultOf(remembered.lastResult))
    return {
      current: deps.running,
      ...(latest !== undefined ? { latest } : {}),
      state,
      ...(state === 'downloading' && percent !== undefined ? { percent } : {}),
      sessions: careful(deps.sessions, 0),
      canRelaunch: careful(deps.canRelaunch, false),
      restartNeeded: installed !== undefined && compareVersions(installed, deps.running) > 0,
      remoteApply: careful(deps.remoteApply, false),
      ...(typeof remembered.lastCheckAt === 'string' ? { checkedAt: remembered.lastCheckAt } : {}),
      ...(lastResult ? { lastResult } : {})
    }
  }

  const changed = (): void => {
    try {
      deps.onChange(status())
    } catch (err) {
      console.warn(`update: a change could not be sent: ${message(err)}`)
    }
  }

  /** One change per new state or new whole percent: a download's thousands of chunks are at most 101. */
  const set = (next: State, nextPercent?: number): void => {
    if (state === next && percent === nextPercent) return
    state = next
    percent = nextPercent
    changed()
  }

  /** Back to idle, and always a change: what the status says besides the state (a result, a pending restart) may be new. */
  const settle = (): void => {
    state = 'idle'
    percent = undefined
    changed()
  }

  const check = (): Promise<UpdateStatus> => {
    if (applying || state === 'restarting') return Promise.reject(codedError('CONFLICT', 'An update is running on this server', { reason: 'busy' }))
    if (checking) return checking
    const at = now().getTime()
    // Read a moment ago: the answer is what that read found, not another round to the feed (and
    // not a `checking` and an `idle` to every client).
    if (lastRead && at - lastRead.at < MIN_CHECK_INTERVAL_MS) {
      return lastRead.error !== undefined ? Promise.reject(checkFailed(lastRead.error)) : Promise.resolve(status())
    }
    const read: { at: number; error?: string } = { at }
    lastRead = read
    set('checking')
    // Inside a promise: a `find` that throws at once is a failed check like one that rejects.
    const run = new Promise<unknown>((done) => done(deps.find()))
      .then(
        () => undefined,
        (err: unknown) => ({ error: message(err) })
      )
      .then((failed) => {
        checking = null
        if (failed) read.error = failed.error
        // The feed was read: how the last attempt ended is old news.
        else failure = null
        set('idle')
        if (failed) throw checkFailed(failed.error)
        return status()
      })
    checking = run
    return run
  }

  const apply = (version: unknown): { started: true } => {
    if (typeof version !== 'string' || version === '') throw codedError('BAD_REQUEST', 'version must be the release to install')
    if (!careful(deps.remoteApply, false)) {
      throw codedError('CONFLICT', "This server's config leaves updating to `trek-server update` on its own machine (updates.remoteApply is false)", { reason: 'disabled' })
    }
    // A check (the daily one, or another client's) is over in a moment, and is not an update.
    if (checking && !applying) throw codedError('CONFLICT', 'This server is checking for an update: try again in a moment', { reason: 'busy' })
    if (applying || state !== 'idle') throw codedError('CONFLICT', 'An update is already running on this server', { reason: 'busy' })
    const latest = status().latest
    if (latest !== version) {
      throw codedError('CONFLICT', latest === undefined ? 'This server has found no newer release: check again' : `The latest release is now ${latest}, not ${version}: check again`, { reason: 'stale' })
    }
    // A new attempt: how the last one ended is not said of this one.
    failure = null
    const started = now().getTime()
    /** This attempt failed: kept for the status, unless the installer recorded this very failure (then its record is the one reported). */
    const failed = (error: string): void => {
      const recorded = resultOf(careful(() => readState(deps.configDir).lastResult, undefined))
      const itsOwn = recorded !== undefined && !recorded.ok && recorded.error === error && Date.parse(recorded.at) >= started
      failure = itsOwn ? null : { ok: false, from: deps.running, to: version, at: now().toISOString(), error }
    }
    // Set before returning, so a status read in the same tick already says an update has begun.
    set('checking')
    // Inside a promise: an installer that throws at once is a failure like one that rejects.
    applying = new Promise<ApplyResult>((done) =>
      done(
        deps.apply({
          expect: { version },
          onStep: (step) => set(STEP_STATE[step]),
          onProgress: (bytes, total) => {
            // Nothing while the size is unknown, and nothing a step other than the download reports.
            if (state !== 'downloading' || total === undefined || !(total > 0)) return
            set('downloading', Math.min(100, Math.max(0, Math.round((bytes / total) * 100))))
          }
        })
      )
    )
      .then(
        (result) => result,
        (err: unknown): ApplyResult => ({ kind: 'failed', error: message(err) })
      )
      .then((result) => {
        applying = null
        if (result.kind === 'failed') {
          console.warn(`update: ${result.error}`)
          failed(result.error)
        }
        if (result.kind === 'installed') {
          try {
            if (deps.canRelaunch() && deps.relaunchRefusal() === null) {
              // The change first: clients hear `restarting`, then the shutdown the relaunch begins.
              set('restarting')
              deps.relaunch(result.to)
              return
            }
          } catch (err) {
            // Clients may have heard `restarting`: the idle that follows says why (restartNeeded is true too).
            const why = `trek-server ${result.to} is installed, but the server could not restart into it: ${message(err)}`
            console.warn(`update: ${why}`)
            failed(why)
          }
        }
        // Installed with no way to restart (restartNeeded is now true), up to date, or failed
        // (the installer recorded why, or `failure` says it).
        settle()
      })
      // Nothing above is expected to throw; a state left at `installing` would refuse every later update.
      .catch((err: unknown) => {
        applying = null
        console.warn(`update: ${message(err)}`)
        failure = { ok: false, from: deps.running, to: version, at: now().toISOString(), error: message(err) }
        settle()
      })
    return { started: true }
  }

  const idle = async (): Promise<void> => {
    await checking?.catch(() => undefined)
    await applying
  }

  return { status, check, apply, idle }
}
