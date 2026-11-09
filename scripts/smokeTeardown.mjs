// scripts/smokeTeardown.mjs — the teardown the Local-server Electron smokes share (4e):
// smoke:local-window, smoke:providers and smoke:windows.
//
// Each smoke runs the built app with a temp HOME, whose supervisor starts the run's own Local
// server (~/.config/trek-server/local-dev under that HOME), and a fake agent that appends its pid
// to a file. The teardown always runs, whatever hangs:
//   - the app is closed, or SIGKILLed after APP_CLOSE_MS;
//   - a hard timer, armed while finishing, stops the server and exits if anything still hangs;
//   - a second SIGINT, SIGTERM or SIGHUP stops the server and exits at once;
//   - the server (`stop --local`, then SIGKILL of what local.json names) and the agents are killed
//     only when their command line is the one expected (a reused pid is left alone);
//   - the work dir is removed on exit too, so a throw while building the fixtures leaves nothing.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { isLocalServerCommand } from '../src/main/localServerRules.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

export const APP_CLOSE_MS = 15_000
const HARD_MS = 45_000
const PROFILE = 'dev'

export const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pid's command line (`ps -o command=`), or '' when ps cannot tell. */
export const commandOf = (pid) => (spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).stdout ?? '').trim()

/** SIGKILLs `pid` when it is alive and its command line passes `expected`; a reused pid is left alone. */
export function killIfOurs(pid, expected, label) {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return
  const command = commandOf(pid)
  if (!expected(command)) {
    console.error(`[teardown] not killing pid ${pid} (${label}): its command line is ${JSON.stringify(command.slice(0, 200))}`)
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/** Closes the app; SIGKILLs its process when the close takes over APP_CLOSE_MS. */
export async function closeApp(app) {
  if (!app) return
  let timer
  const closed = await Promise.race([
    app.close().then(
      () => true,
      () => true
    ),
    new Promise((done) => (timer = setTimeout(() => done(false), APP_CLOSE_MS)))
  ])
  clearTimeout(timer)
  if (closed) return
  console.error(`[teardown] the app did not close in ${APP_CLOSE_MS} ms: SIGKILL`)
  try {
    app.process().kill('SIGKILL')
  } catch {}
}

/**
 * The run's teardown, synchronous and run once: the Local server in `home` stopped, the agents
 * listed in `agentPids` (one pid first on each line) killed, `extra` (say, git worktree prune),
 * then `work` removed. `isAgent(command)` tells an agent's command line.
 */
export function localTeardown({ root, home, work, agentPids, isAgent }) {
  const infoPath = join(home, '.config', 'trek-server', `local-${PROFILE}`, 'local.json')
  // A throw before the run's try (the fixtures) exits without finish: remove the work dir anyway.
  process.on('exit', () => rmSync(work, { recursive: true, force: true }))
  const info = () => {
    try {
      return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
    } catch {
      return undefined
    }
  }
  let done = false
  const teardown = (extra = () => {}) => {
    if (done) return
    done = true
    spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', PROFILE], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15_000
    })
    const left = info()
    if (left) killIfOurs(left.pid, (command) => isLocalServerCommand(command, PROFILE), 'the Local server')
    const pids = existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map((line) => Number(line.trim().split(/\s+/)[0])) : []
    for (const pid of pids) killIfOurs(pid, isAgent, 'a fake agent')
    try {
      extra()
    } catch {}
    rmSync(work, { recursive: true, force: true })
  }
  return { info, teardown }
}

/**
 * The smoke's finish(reason): the app closed (closeApp) under a hard timer, then `teardown()`,
 * then `report(reason)` prints the result line and returns the exit code. A second signal
 * tears down and exits at once.
 */
export function makeFinish({ getApp, beforeClose = () => {}, teardown, report }) {
  let finishing = false
  const abort = (why) => {
    console.error(why)
    teardown()
    report(why)
    process.exit(1)
  }
  const finish = async (reason) => {
    if (finishing) return
    finishing = true
    if (reason) console.error(reason)
    const hard = setTimeout(() => abort(`[teardown] still hanging after ${HARD_MS} ms: stopping the server and exiting`), HARD_MS)
    try {
      beforeClose()
    } catch {}
    await closeApp(getApp())
    clearTimeout(hard)
    teardown()
    process.exit(report(reason))
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!finishing) void finish(`interrupted (${signal})`)
      else abort(`${signal} again: stopping the server and exiting`)
    })
  }
  return finish
}
