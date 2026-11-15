// `trek-server update`: says what it found, asks, installs, and has a running server restart into
// the new version. `--check` only looks. Exit 0: up to date, or updated. Exit 1: not possible here,
// it failed (the install is then as it was), or the running server did not come back as the new
// version in time.
import { createInterface } from 'node:readline/promises'
import { dirname, resolve } from 'node:path'
import type { CliArgs } from '../cli.ts'
import { applyUpdate, findUpdate, type ApplyDeps, type UpdateStep } from './apply.ts'
import { controlPath, controlRequest, type ControlStatus } from './control.ts'
import type { Release } from './feed.ts'
import { previousDir } from './install.ts'
import { updateSource } from './keys.ts'
import { readInstall } from './updatable.ts'

const STEPS: Record<UpdateStep, string> = {
  checking: 'Checking the latest release…',
  downloading: 'Downloading…',
  unpacking: 'Unpacking…',
  selfcheck: 'Checking the new version runs here…',
  installing: 'Installing…'
}

/** Every way the command ends */
export type UpdateOutcome =
  | { kind: 'cannot-update'; reason: string }
  | { kind: 'feed-error'; error: string }
  | { kind: 'latest'; current: string }
  /** `--check`, and a newer release exists */
  | { kind: 'available'; current: string; latest: string }
  /** The server running with this config runs from another folder */
  | { kind: 'other-install'; configPath: string; pid: number; installDir: string }
  /** Nobody to ask (no terminal), and no `--yes` */
  | { kind: 'needs-yes'; latest: string }
  | { kind: 'declined' }
  | { kind: 'failed'; current: string; error: string }
  /** Installed, and no server answered on this config's control socket */
  | { kind: 'installed'; to: string; previous: string }
  /** Installed, and the running server said it is now the new version */
  | { kind: 'restarted'; to: string; pid: number }
  /** Installed, the running server agreed to restart, and has not said it is the new version in time */
  | { kind: 'restart-unconfirmed'; to: string; pid: number; seconds: number }
  /** Installed, but the running server did not restart into it */
  | { kind: 'restart-needed'; to: string; pid: number; why: string }

/** What is said for an outcome (on stderr when the exit code is 1) and the command's exit code. */
export function describeOutcome(outcome: UpdateOutcome): { lines: string[]; exitCode: number } {
  switch (outcome.kind) {
    case 'cannot-update':
      return { exitCode: 1, lines: [`trek-server cannot update itself here: ${outcome.reason}`] }
    case 'feed-error':
      return { exitCode: 1, lines: [`Could not check for an update: ${outcome.error}`] }
    case 'latest':
      return { exitCode: 0, lines: [`trek-server ${outcome.current} is the latest version`] }
    case 'available':
      return { exitCode: 0, lines: [`trek-server ${outcome.current}; ${outcome.latest} is available (run \`trek-server update\`)`] }
    case 'other-install':
      return {
        exitCode: 1,
        lines: [`The server running with ${outcome.configPath} (pid ${outcome.pid}) is another install, ${outcome.installDir}: run its own \`trek-server update\`.`]
      }
    case 'needs-yes':
      return { exitCode: 1, lines: [`trek-server ${outcome.latest} is available. Run \`trek-server update --yes\` to install it without being asked.`] }
    case 'declined':
      return { exitCode: 0, lines: ['Not updated.'] }
    case 'failed':
      return { exitCode: 1, lines: [`The update failed, and trek-server ${outcome.current} is as it was:`, outcome.error] }
    case 'installed':
      // No answer is not proof that none runs: a server without a control socket (its path too
      // long, a folder it could not write) or one started with another --config is not found here.
      return {
        exitCode: 0,
        lines: [
          `Updated to trek-server ${outcome.to}. The version before it is kept in ${outcome.previous}.`,
          `No running server answered for this config. A trek-server that is already running from this install still runs the old version: restart it to use ${outcome.to}.`
        ]
      }
    case 'restarted':
      return { exitCode: 0, lines: [`Installed trek-server ${outcome.to}; the running server (pid ${outcome.pid}) is now running ${outcome.to}.`] }
    case 'restart-unconfirmed':
      return {
        exitCode: 1,
        lines: [
          `Installed trek-server ${outcome.to}. The running server (pid ${outcome.pid}) agreed to restart into it, but has not come back as ${outcome.to} within ${outcome.seconds} s: look at its log, and start it again if it is not running.`
        ]
      }
    case 'restart-needed':
      return { exitCode: 0, lines: [`Installed trek-server ${outcome.to}. Restart the running server (pid ${outcome.pid}) to finish: ${outcome.why}.`] }
  }
}

/** The question asked before installing; `server`: the one running with this config, which restarts into the new version if it can. */
export function confirmQuestion(current: string, latest: string, server: Pick<ControlStatus, 'pid' | 'sessions' | 'canRelaunch'> | null): string {
  const question = `Update trek-server ${current} to ${latest}?`
  if (!server) return question
  if (!server.canRelaunch) {
    return `${question} The running server (pid ${server.pid}) cannot restart itself into it (its Node is older than 22.15): it keeps running ${current} until you restart it.`
  }
  const restarts = `${question} The running server (pid ${server.pid}) restarts into it`
  if (server.sessions === 0) return `${restarts}; it has no terminals open.`
  const closes = server.sessions === 1 ? 'its 1 terminal closes' : `its ${server.sessions} terminals close`
  return `${restarts}: ${closes}, and agent sessions resume when their worktrees are opened again.`
}

/** How long a server that agreed to restart has to answer as the new version: its shutdown takes up to about 2 s, its start about one. */
const RESTART_WAIT_MS = 15_000
const RESTART_POLL_MS = 200

export interface AwaitVersionDeps {
  /** One `status` request on the control socket; null when nothing answers */
  request: () => Promise<unknown | null>
  now: () => number
  sleep: (ms: number) => Promise<void>
  timeoutMs?: number
  everyMs?: number
}

/**
 * Asks the running server what it is until it answers as `version`: its status then, or null
 * when it has not within the time (it is still the old version, or answers nothing: gone, or
 * not back yet).
 */
export async function awaitVersion(version: string, deps: AwaitVersionDeps): Promise<ControlStatus | null> {
  const deadline = deps.now() + (deps.timeoutMs ?? RESTART_WAIT_MS)
  for (;;) {
    const status = await deps.request()
    if (isStatus(status) && status.version === version) return status
    if (deps.now() >= deadline) return null
    await deps.sleep(deps.everyMs ?? RESTART_POLL_MS)
  }
}

function isStatus(value: unknown): value is ControlStatus {
  const s = value as ControlStatus | null
  return s !== null && typeof s === 'object' && typeof s.pid === 'number' && typeof s.version === 'string' && typeof s.installDir === 'string' && typeof s.sessions === 'number'
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

async function update(args: CliArgs, installDir: string): Promise<UpdateOutcome> {
  // First, and before anything is asked of the network: only a tarball install has anything to replace.
  const found = readInstall(installDir)
  if (!found.ok) return { kind: 'cannot-update', reason: found.reason }
  const { install } = found
  const configPath = resolve(args.configPath)
  const source = updateSource()
  const deps: ApplyDeps = {
    install,
    configDir: dirname(configPath),
    feed: source.feed,
    keys: source.keys,
    fetch,
    onStep: (step) => console.log(STEPS[step])
  }

  let release: Release | null
  try {
    release = await findUpdate(deps)
  } catch (err) {
    return { kind: 'feed-error', error: err instanceof Error ? err.message : String(err) }
  }
  if (!release) return { kind: 'latest', current: install.version }
  // `--check` ends here, whatever it found: it never installs.
  if (args.check) return { kind: 'available', current: install.version, latest: release.version }

  const running = await controlRequest(controlPath(configPath), 'status')
  const server = isStatus(running) ? running : null
  if (server && resolve(server.installDir) !== resolve(install.dir)) {
    return { kind: 'other-install', configPath, pid: server.pid, installDir: server.installDir }
  }

  if (!args.yes) {
    if (!process.stdin.isTTY) return { kind: 'needs-yes', latest: release.version }
    if (!(await confirm(confirmQuestion(install.version, release.version, server)))) return { kind: 'declined' }
  }

  // The release that was shown and agreed to, and no other: the feed is read again under the update's lock.
  const result = await applyUpdate({ ...deps, expect: { version: release.version, retry: 'run `trek-server update` again' } })
  if (result.kind === 'failed') return { kind: 'failed', current: install.version, error: result.error }
  if (result.kind === 'up-to-date') return { kind: 'latest', current: result.current }
  if (!server) return { kind: 'installed', to: result.to, previous: previousDir(install.dir) }
  const answer = (await controlRequest(controlPath(configPath), 'relaunch')) as { ok?: unknown; error?: unknown } | null
  if (answer !== null && typeof answer === 'object' && answer.ok === true) {
    // "ok" is the server agreeing to restart, not the new version running: wait for it to say so.
    const now = await awaitVersion(result.to, {
      request: () => controlRequest(controlPath(configPath), 'status'),
      now: Date.now,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms))
    })
    return now ? { kind: 'restarted', to: result.to, pid: now.pid } : { kind: 'restart-unconfirmed', to: result.to, pid: server.pid, seconds: RESTART_WAIT_MS / 1000 }
  }
  const why = answer !== null && typeof answer === 'object' && typeof answer.error === 'string' ? answer.error : 'the running server did not answer'
  return { kind: 'restart-needed', to: result.to, pid: server.pid, why }
}

/** `installDir`: the folder of the running trek-server.cjs, '' in a source run. Returns the exit code. */
export async function runUpdateCommand(args: CliArgs, installDir: string): Promise<number> {
  const { lines, exitCode } = describeOutcome(await update(args, installDir))
  const say = exitCode === 0 ? console.log : console.error
  for (const line of lines) say(line)
  return exitCode
}
