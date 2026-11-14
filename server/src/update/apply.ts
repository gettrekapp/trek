// One update, in order: read the signed feed, download this target's tarball and check its hash,
// unpack it beside the install, ask the new version to prove it runs (its own `selfcheck`), and
// only then swap it into the install's place, marked pending until it starts. Anything that
// fails before the swap leaves the install, and a server running from it, untouched. One update
// at a time per install (lock.ts: a lock beside it).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hidden } from '../../../src/host/childOptions.ts'
import { commandPath } from '../../../src/host/commandPath.ts'
import { compareVersions } from '../../../src/shared/versions.ts'
import { fetchRelease, tarballUrl, type Release } from './feed.ts'
import { download, flushDir, flushTree, swap, sweepLeftovers, unpack, validateStaged } from './install.ts'
import { LEFTOVER_PREFIX, LOCK_FILE, takeLock, type UpdateLock } from './lock.ts'
import { launcherPath, relaunchEnv } from './relaunch.ts'
import { writePending, writeState } from './state.ts'
import type { Install } from './updatable.ts'

export { LOCK_FILE }
const SELFCHECK_TIMEOUT_MS = 60_000

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
  selfcheck?: (stagedDir: string) => SelfcheckOutcome
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
 * that does not finish in time, or is killed, has failed.
 */
export function runStagedSelfcheck(stagedDir: string, timeoutMs: number = SELFCHECK_TIMEOUT_MS, env: NodeJS.ProcessEnv = relaunchEnv()): SelfcheckOutcome {
  const run = spawnSync(commandPath(launcherPath(stagedDir)), ['selfcheck'], hidden({ encoding: 'utf8' as const, timeout: timeoutMs, killSignal: 'SIGKILL' as const, env }))
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
  const failed = (why: string): SelfcheckOutcome => ({ ok: false, output: `${output}\n${why}`.trim() })
  if (run.error) {
    const timedOut = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    return failed(timedOut ? `selfcheck did not finish within ${timeoutMs / 1000} s` : `selfcheck could not be run: ${run.error.message}`)
  }
  if (run.status === null) return failed(`selfcheck was ended by ${run.signal ?? 'a signal'}`)
  return { ok: run.status === 0, output }
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

    deps.onStep?.('checking')
    const release = await findUpdate(deps)
    if (!release) return { kind: 'up-to-date', current: install.version }
    target = release.version

    // A new folder (0700) with a name nobody could have known: nothing was put in it beforehand,
    // and nobody else can put anything in it now.
    deps.onStep?.('downloading')
    work = mkdtempSync(join(install.parent, LEFTOVER_PREFIX))
    const tarball = join(work, 'download.tar.gz')
    await download(tarballUrl(deps.feed, release), tarball, release.sha256, { fetch: deps.fetch, onProgress: deps.onProgress })

    deps.onStep?.('unpacking')
    const staged = unpack(tarball, join(work, 'stage'))
    validateStaged(staged, { version: release.version, target: install.target })

    deps.onStep?.('selfcheck')
    const check = (deps.selfcheck ?? runStagedSelfcheck)(staged)
    if (!check.ok) throw new Error(`trek-server ${release.version} does not run on this machine, so ${install.version} stays:\n${check.output}`)

    // Nothing has been written into the install up to here. The marker goes into the staged
    // folder, and the swap, which is the only step that touches the install, is the last one.
    deps.onStep?.('installing')
    writePending(staged, { from: install.version, to: release.version, at: now().toISOString() })
    // On disk before it is renamed into place, and the renames after: a power cut must not leave
    // the new version's name on files whose data never arrived.
    flushTree(staged)
    swap(install.dir, staged)
    flushDir(install.parent)
    return { kind: 'installed', from: install.version, to: release.version }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try {
      writeState(deps.configDir, { lastResult: { ok: false, from: install.version, to: target ?? install.version, at: now().toISOString(), error } })
    } catch {
      // The record is a courtesy: the failure is still returned.
    }
    return { kind: 'failed', error }
  } finally {
    if (work) remove(work)
    held?.release()
  }
}
