// One update, in order: read the signed feed, download this target's tarball and check its hash,
// unpack it beside the install, ask the new version to prove it runs (its own `selfcheck`), and
// only then swap it into the install's place, marked pending until it starts. Anything that
// fails before the swap leaves the install, and a server running from it, untouched. One update
// at a time per install (lock.ts: a lock beside it).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hidden } from '../../../src/host/childOptions.ts'
import { commandPath } from '../../../src/host/commandPath.ts'
import { compareVersions } from '../../../src/shared/versions.ts'
import { fetchRelease, tarballUrl, type Release } from './feed.ts'
import { download, failedDir, flushDir, flushTree, swap, sweepLeftovers, unpack, validateStaged } from './install.ts'
import { LEFTOVER_PREFIX, LOCK_FILE, takeLock, type UpdateLock } from './lock.ts'
import { launcherPath, relaunchEnv } from './relaunch.ts'
import { writePending, writeState } from './state.ts'
import type { Install } from './updatable.ts'

export { LOCK_FILE }
const SELFCHECK_TIMEOUT_MS = 60_000
/** The most a selfcheck may print (a real one prints a few lines): one that goes on is stopped */
const SELFCHECK_MAX_OUTPUT = 1024 * 1024

export type UpdateStep = 'checking' | 'downloading' | 'unpacking' | 'selfcheck' | 'installing'

export interface SelfcheckOutcome {
  ok: boolean
  output: string
}

/** What looking for an update needs */
export interface FindDeps {
  install: Install
  /** Where update-state.json is kept: the config file's folder */
  configDir: string
  feed: string
  keys: readonly string[]
  fetch: typeof fetch
  now?: () => Date
}

export interface ApplyDeps extends FindDeps {
  onStep?: (step: UpdateStep) => void
  onProgress?: (bytes: number, total: number | undefined) => void
  /** Runs the staged version's `selfcheck`; the default runs it through the staged launcher */
  selfcheck?: (stagedDir: string) => SelfcheckOutcome | Promise<SelfcheckOutcome>
  /**
   * The release the caller showed and had confirmed: the update fails if the latest is another by
   * now. `retry`: what that failure says to do next (the command names itself; a client is shown
   * the default).
   */
  expect?: { version: string; retry?: string }
}

export type ApplyResult =
  | { kind: 'up-to-date'; current: string }
  | { kind: 'installed'; from: string; to: string }
  | { kind: 'failed'; error: string }

/**
 * The staged version's own `trek-server selfcheck`, run the way the server will be started:
 * through the staged launcher (so one that is not executable, does not parse or finds no usable
 * Node fails here, before the swap), with the Node a relaunch hands it (`env`). The launcher marks
 * nothing for it: selfcheck is not a start, and the staged folder has no pending update yet. One
 * that does not finish in time, or is killed, has failed. Never rejects, and never holds the
 * event loop: the server that asked keeps serving while the new version proves itself.
 */
export function runStagedSelfcheck(stagedDir: string, timeoutMs: number = SELFCHECK_TIMEOUT_MS, env: NodeJS.ProcessEnv = relaunchEnv()): Promise<SelfcheckOutcome> {
  return new Promise((resolve) => {
    const launcher = launcherPath(stagedDir)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let flooded = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const output = (): string => `${stdout}${stderr}`.trim()
    const finish = (outcome: SelfcheckOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const failed = (why: string): void => finish({ ok: false, output: `${output()}\n${why}`.trim() })
    let child: ChildProcess
    try {
      child = spawn(commandPath(launcher), ['selfcheck'], hidden<SpawnOptions>({ env, stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (err) {
      failed(`selfcheck could not be run: ${(err as Error).message}`)
      return
    }
    const collect = (chunk: string, to: 'out' | 'err'): void => {
      if (flooded) return
      const room = SELFCHECK_MAX_OUTPUT - stdout.length - stderr.length
      if (to === 'out') stdout += chunk.slice(0, room)
      else stderr += chunk.slice(0, room)
      if (chunk.length > room) {
        flooded = true
        child.kill('SIGKILL')
      }
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => collect(chunk, 'out'))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => collect(chunk, 'err'))
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const ended = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timedOut) failed(`selfcheck did not finish within ${timeoutMs / 1000} s`)
      else if (flooded) failed(`selfcheck could not be run: spawn ${launcher} ENOBUFS`)
      else if (code === null) failed(`selfcheck was ended by ${signal ?? 'a signal'}`)
      else finish({ ok: code === 0, output: output() })
    }
    child.on('error', (err) => failed(`selfcheck could not be run: ${err.message}`))
    // 'close': its output has all arrived. One that was killed may have left a process of its own
    // holding the pipes, so its exit is enough.
    child.on('close', ended)
    child.on('exit', (code, signal) => {
      if (timedOut || flooded) ended(code, signal)
    })
  })
}

/**
 * The latest release when it is newer than this install, else null. Records the check, once the
 * feed has verified. Throws when the feed cannot be read or verified, and then records nothing:
 * what the last check found stays.
 */
export async function findUpdate(deps: FindDeps): Promise<Release | null> {
  const release = await fetchRelease({ feed: deps.feed, keys: deps.keys, target: deps.install.target, fetch: deps.fetch })
  const newer = compareVersions(release.version, deps.install.version) > 0
  writeState(deps.configDir, { lastCheckAt: (deps.now?.() ?? new Date()).toISOString(), latest: newer ? release.version : undefined })
  return newer ? release : null
}

/** The version in the install folder now (its build.json), which another update may have changed since this one read it. */
function installedVersion(dir: string): string {
  try {
    const build = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as { version?: unknown } | null
    if (build !== null && typeof build === 'object' && typeof build.version === 'string') return build.version
  } catch {
    // Said below.
  }
  throw new Error(`${join(dir, 'build.json')} cannot be read any more: not replacing an install that cannot say what it is`)
}

/** Removes what an update leaves beside the install. Never throws: what cannot be removed is replaced by the next update. */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (err) {
    console.warn(`update: could not remove ${path}: ${(err as Error).message}`)
  }
}

/**
 * Finds, downloads, checks and installs the latest release. Never throws: a failure is a result,
 * and is recorded (update-state.json's lastResult). A success is not recorded here: the new
 * version records it when it starts (settleStart), which is when it is known to be one.
 */
export async function applyUpdate(deps: ApplyDeps): Promise<ApplyResult> {
  const { install } = deps
  const now = (): Date => deps.now?.() ?? new Date()
  const lock = join(install.parent, LOCK_FILE)
  let held: UpdateLock | null = null
  /** This update's own folder beside the install: its download and what it unpacks. */
  let work: string | undefined
  let target: string | undefined
  let from = install.version
  try {
    held = takeLock(lock)
    // Not recorded as this install's last result: the update that holds the lock records its own.
    if (!held) {
      return {
        kind: 'failed',
        error: `another update is running for ${install.dir}: ${lock} is its lock (a folder that holds that update's process id). If no update is running, remove it.`
      }
    }

    // What updates that were killed left here: only the holder of the lock removes anything.
    sweepLeftovers(install.parent, now().getTime())

    // Read again now that the lock is held: an update that finished while this one waited to
    // be confirmed has already replaced the install, and installing over it would put that new
    // version in <install>.previous in place of the one worth going back to.
    from = installedVersion(install.dir)

    deps.onStep?.('checking')
    const release = await findUpdate({ ...deps, install: { ...install, version: from } })
    if (!release) return { kind: 'up-to-date', current: from }
    target = release.version
    if (deps.expect && release.version !== deps.expect.version) {
      throw new Error(`the latest release is now trek-server ${release.version}, not the ${deps.expect.version} that was confirmed: ${deps.expect.retry ?? 'check again'}`)
    }

    // A new folder (0700) with a name nobody could have known: nothing was put in it beforehand,
    // and nobody else can put anything in it now.
    deps.onStep?.('downloading')
    work = mkdtempSync(join(install.parent, LEFTOVER_PREFIX))
    const tarball = join(work, 'download.tar.gz')
    await download(tarballUrl(deps.feed, release), tarball, release.sha256, { fetch: deps.fetch, onProgress: deps.onProgress })

    deps.onStep?.('unpacking')
    const staged = await unpack(tarball, join(work, 'stage'))
    validateStaged(staged, { version: release.version, target: install.target })

    deps.onStep?.('selfcheck')
    const check = await (deps.selfcheck ?? runStagedSelfcheck)(staged)
    if (!check.ok) throw new Error(`trek-server ${release.version} does not run on this machine, so ${from} stays:\n${check.output}`)

    // Nothing has been written into the install up to here. The marker goes into the staged
    // folder, and the swap, which is the only step that touches the install, is the last one.
    deps.onStep?.('installing')
    writePending(staged, { from, to: release.version, at: now().toISOString() })
    // What the last rollback set aside to be looked at: kept until an update gets this far.
    remove(failedDir(install.dir))
    // On disk before it is renamed into place, and the renames after: a power cut must not leave
    // the new version's name on files whose data never arrived.
    await flushTree(staged)
    // The two renames, with nothing of this process between them.
    swap(install.dir, staged)
    await flushDir(install.parent)
    return { kind: 'installed', from, to: release.version }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try {
      // `to`: the release that was being installed. When the feed could not be read at all, that is
      // the one the caller confirmed: a failure "from 1.0.0 to 1.0.0" would be a failure of nothing.
      writeState(deps.configDir, { lastResult: { ok: false, from, to: target ?? deps.expect?.version ?? from, at: now().toISOString(), error } })
    } catch {
      // The record is a courtesy: the failure is still returned.
    }
    return { kind: 'failed', error }
  } finally {
    if (work) remove(work)
    held?.release()
  }
}
