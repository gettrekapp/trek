// Smoke for `trek-server start --local`, run from the built bundle the way the
// app will run it (phase 4b): copied into a bare out/server with only node-pty
// beside it (no server/node_modules), in a temp HOME, under Node and then under
// Electron's Node (ELECTRON_RUN_AS_NODE=1). For each runtime: local.json (0600,
// its fields, the build), a welcome with `local` and `mcp`, a repo registered
// outside any root, a session on a fake agent through node-pty (without
// ELECTRON_RUN_AS_NODE under Electron), a second start
// refused by the lock, `stop --local` and SIGTERM's cleanup, SIGHUP's cleanup, a SIGKILLed
// server's stale lock (and its temp files) taken over with a new token, the
// session resumed with --resume, a lock path that cannot be taken, and a named
// profile (`--local-profile dev`, a dev build's) running beside the default one.
//
// With --packaged <Trek.app>, it runs the same checks on a packaged app instead: the app's own
// binary with ELECTRON_RUN_AS_NODE=1, on Contents/Resources/app.asar/out/server/trek-server.cjs
// (read from inside the asar), with node-pty and its spawn-helper from app.asar.unpacked.
//
//   node scripts/local-server-smoke.mjs [--node-only | --electron-only | --packaged <Trek.app>]
import './smokeGh.mjs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, TopicMirror, globalSocketFactory } from '../src/shared/client/index.ts'
import { LOCAL_ALREADY_RUNNING_EXIT, parseLocalInfo } from '../src/shared/localServer.ts'

const WAIT_MS = 15000
const root = new URL('..', import.meta.url).pathname
const bundle = join(root, 'server', 'dist', 'trek-server.cjs')
const built = JSON.parse(readFileSync(join(root, 'server', 'dist', 'build.json'), 'utf8'))

const packagedAt = process.argv.indexOf('--packaged')
const packaged = packagedAt >= 0 && process.argv[packagedAt + 1] ? resolve(process.argv[packagedAt + 1]) : null
if (packagedAt >= 0 && !packaged) {
  console.error('usage: --packaged <path to Trek.app>')
  process.exit(2)
}
const runtimes = packaged
  ? [
      {
        name: 'packaged',
        cmd: join(packaged, 'Contents', 'MacOS', 'Trek'),
        env: { ELECTRON_RUN_AS_NODE: '1' },
        cli: join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'server', 'trek-server.cjs')
      }
    ]
  : [
      { name: 'node', cmd: process.execPath, env: {} },
      { name: 'electron', cmd: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    ].filter((r) => !process.argv.includes(r.name === 'node' ? '--electron-only' : '--node-only'))

let checks = 0
let failed = false
const ok = (msg) => { checks++; console.log(`ok: ${msg}`) }
const fail = (msg) => { checks++; failed = true; console.error(`FAIL: ${msg}`) }
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(detail ? `${msg}: ${detail}` : msg))

/** Resolves true once `pred()` holds, false after `ms`. */
const waitFor = async (pred, ms = WAIT_MS) => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  return pred()
}

/** Thrown to skip the rest of a runtime's checks after one they depend on. */
class Abort extends Error {}
const must = (cond, msg, detail = '') => {
  check(cond, msg, detail)
  if (!cond) throw new Abort(msg)
}

async function suite(rt) {
  console.log(`--- ${rt.name} (${rt.cmd}) ---`)
  const work = realpathSync(mkdtempSync(join(tmpdir(), `trek-local-smoke-${rt.name}-`)))
  const home = join(work, 'home')
  // The app's layout: out/server/trek-server.cjs, and node-pty in the app's node_modules.
  const app = join(work, 'app')
  mkdirSync(join(app, 'out', 'server'), { recursive: true })
  mkdirSync(join(app, 'node_modules'))
  // A packaged app brings its own: the bundle inside app.asar, node-pty in app.asar.unpacked.
  const cli = rt.cli ?? join(app, 'out', 'server', 'trek-server.cjs')
  if (!rt.cli) {
    copyFileSync(bundle, cli)
    symlinkSync(join(root, 'node_modules', 'node-pty'), join(app, 'node_modules', 'node-pty'))
  }
  const env = { ...process.env, ...rt.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }
  // Only the app's node_modules may resolve: no NODE_PATH fallback.
  delete env.NODE_PATH
  const profile = join(home, '.config', 'trek-server', 'local')
  const infoPath = join(profile, 'local.json')
  const lockPath = join(profile, 'local.lock')

  // A fake agent that prints its arguments and ELECTRON_RUN_AS_NODE, and lingers until it is killed.
  const fakeAgent = join(work, 'fake-agent.sh')
  writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\necho "RUN_AS_NODE=${ELECTRON_RUN_AS_NODE-unset}"\nexec sleep 300\n', { mode: 0o755 })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
  // A repo with no registered repo anywhere near it.
  const repo = join(work, 'elsewhere', 'deep', 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@s' }
  })

  const children = []
  const conns = []
  const start = (extra = []) => {
    const child = spawn(rt.cmd, [cli, 'start', '--local', ...extra], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const run = { child, out: '', err: '', code: undefined }
    child.stdout.on('data', (d) => { run.out += d })
    child.stderr.on('data', (d) => { run.err += d })
    run.exited = new Promise((resolve) => child.on('exit', (code, signal) => { run.code = code ?? signal; resolve(run.code) }))
    children.push(run)
    return run
  }
  /** Runs a short CLI command to its end without blocking the event loop (the servers' output keeps flowing). */
  const runCli = (argv) =>
    new Promise((resolve) => {
      const p = spawn(rt.cmd, [cli, ...argv], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      p.on('exit', (code) => resolve({ code, out, err }))
    })
  const info = (path = infoPath) => {
    try {
      return parseLocalInfo(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return undefined
    }
  }
  // local.lock is `<pid>\n<nonce>\n`: the pid is its first line.
  const lockPid = (path = lockPath) => (existsSync(path) ? Number(readFileSync(path, 'utf8').split('\n')[0].trim()) : undefined)
  const connect = async (port, token, name) => {
    const conn = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: `local-smoke-${name}` })
    conns.push(conn)
    conn.connect()
    await waitFor(() => conn.status === 'connected' || conn.status === 'needs-auth', 5000)
    return conn
  }
  const stopAll = async () => {
    for (const c of conns.splice(0)) c.close()
    for (const r of children) if (r.code === undefined) r.child.kill('SIGKILL')
    await Promise.all(children.map((r) => r.exited))
  }

  try {
    // --- 1. --local takes no profile options ---
    const refused = spawnSync(rt.cmd, [cli, 'start', '--local', '--port', '7999'], { env, encoding: 'utf8' })
    check(refused.status === 2 && refused.stderr.includes('--local has its own config'), '--local with --port is a usage error (exit 2)', `${refused.status} ${refused.stderr.slice(0, 200)}`)

    // --- 2. start: local.json ---
    const a = start()
    must(await waitFor(() => info()?.pid === a.child.pid || a.code !== undefined), 'local.json appears with the server\'s pid', `code ${a.code}, ${a.err}`)
    const infoA = info()
    check((statSync(infoPath).mode & 0o777) === 0o600, 'local.json is 0600', (statSync(infoPath).mode & 0o777).toString(8))
    check(infoA.version === built.version && infoA.build === built.build, `local.json has the bundle's version and build (${infoA.version}, ${infoA.build})`, JSON.stringify(infoA))
    check(lockPid() === a.child.pid, 'local.lock holds the pid')
    // The smoke made the profile directory 0755; the lock tightens it.
    check((statSync(profile).mode & 0o777) === 0o700, 'the profile directory is 0700', (statSync(profile).mode & 0o777).toString(8))
    check(a.out.includes(`listening on ws://127.0.0.1:${infoA.port}`), 'it listens on 127.0.0.1 at the port in local.json', a.out)

    // --- 3. the welcome ---
    const conn = await connect(infoA.port, infoA.token, 'a')
    must(conn.status === 'connected', 'a hello with the local.json token is welcomed', `${conn.status} ${conn.statusMessage}`)
    const caps = conn.welcome.capabilities
    check(caps.includes('local') && caps.includes('mcp'), `the first welcome lists local and mcp (${caps.join(',')})`)

    // --- 4. a repo outside any root, a project, a session through node-pty ---
    let repoId
    try {
      repoId = (await conn.request('server.addRepo', { path: repo })).repoId
      ok(`server.addRepo takes ${repo} (repo "${repoId}")`)
    } catch (err) {
      must(false, 'server.addRepo outside any root', `${err.code} ${err.message}`)
    }
    const { projectId } = await conn.request('project.create', { name: 'Local', repositories: [{ path: repo }] })
    const mirror = new TopicMirror(conn)
    let project = null
    mirror.subscribe(`project:${projectId}`, (u) => { if (!('error' in u)) project = u.snapshot })
    const mainWt = () => project?.repositories[0]?.worktrees.find((w) => w.isMain)
    must(await waitFor(() => !!mainWt()), 'the project topic has the main worktree')
    const started = await conn.request('session.start', { projectId, worktreeId: mainWt().id, cols: 80, rows: 24 })
    const ptys = new PtyStream(conn)
    let text = ''
    await ptys.attach(started.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
    must(await waitFor(() => /FAKE_AGENT .*--session-id (\S+)/.test(text)), `node-pty runs the agent under ${rt.name}: it printed --session-id`, JSON.stringify(text))
    const agentSessionId = /--session-id (\S+)/.exec(text)[1]
    if (rt.name !== 'node') {
      // The server runs with ELECTRON_RUN_AS_NODE=1; an Electron app started from a session must not.
      check(await waitFor(() => /RUN_AS_NODE=\S+/.test(text)) && text.includes('RUN_AS_NODE=unset'), "the session's pty does not inherit ELECTRON_RUN_AS_NODE", JSON.stringify(text))
    }

    // --- 5. a second start is refused by the lock ---
    const b = start()
    await b.exited
    check(b.code === LOCAL_ALREADY_RUNNING_EXIT && b.err.includes(`already running (pid ${a.child.pid})`), `a second --local start exits ${LOCAL_ALREADY_RUNNING_EXIT}: already running`, `${b.code} ${b.err}`)
    check(info()?.pid === a.child.pid && lockPid() === a.child.pid, "the refused start leaves local.json and the lock alone")

    // --- 6. stop --local: SIGTERM, and the cleanup ---
    for (const c of conns.splice(0)) c.close()
    const stopped = await runCli(['stop', '--local'])
    await Promise.race([a.exited, new Promise((r) => setTimeout(r, 5000))])
    check(stopped.code === 0 && stopped.out.includes(`Stopping the local trek-server (pid ${a.child.pid})`) && stopped.out.includes('Stopped.'), 'stop --local stops it: exit 0, "Stopped."', `${stopped.code} ${stopped.out} ${stopped.err}`)
    check(a.code === 0, 'SIGTERM: the server exits 0', String(a.code))
    check(!existsSync(infoPath) && !existsSync(lockPath), 'SIGTERM removes local.json and local.lock')
    const again = await runCli(['stop', '--local'])
    check(again.code === 0 && again.out.includes('No local trek-server is running.'), 'stop --local with none running: exit 0, "not running"', `${again.code} ${again.out} ${again.err}`)

    // --- 7. a SIGKILLed server leaves a stale lock and local.json ---
    const c = start()
    must(await waitFor(() => info()?.pid === c.child.pid || c.code !== undefined), 'a third start writes local.json', c.err)
    const infoC = info()
    c.child.kill('SIGKILL')
    await c.exited
    check(info()?.pid === c.child.pid && lockPid() === c.child.pid, 'SIGKILL leaves local.json and local.lock behind')
    // Temp files a crash could leave mid-write, under the dead pid.
    const temps = [`local.lock.${c.child.pid}.tmp`, `local.json.${c.child.pid}.tmp`].map((n) => join(profile, n))
    for (const tmp of temps) writeFileSync(tmp, '')

    // --- 8. the next start takes the stale lock over, with a new token ---
    const d = start()
    must(await waitFor(() => info()?.pid === d.child.pid || d.code !== undefined), 'the next start takes over and writes local.json', `code ${d.code}, ${d.err}`)
    const infoD = info()
    check(d.out.includes(`Took over the lock of a local trek-server that is gone (pid ${c.child.pid})`), 'it reports the dead pid it took over', d.out)
    check(lockPid() === d.child.pid, 'local.lock now holds the new pid')
    check(temps.every((tmp) => !existsSync(tmp)), "the dead pid's temp files are removed")
    check(infoD.token !== infoC.token, 'a new token on every start')
    const stale = await connect(infoD.port, infoC.token, 'stale')
    check(stale.status === 'needs-auth', "the dead server's token is refused", stale.status)
    const connD = await connect(infoD.port, infoD.token, 'd')
    must(connD.status === 'connected', 'the new token is welcomed', `${connD.status} ${connD.statusMessage}`)

    // --- 9. the session from before the SIGTERM resumes ---
    const mirrorD = new TopicMirror(connD)
    let projectD = null
    mirrorD.subscribe(`project:${projectId}`, (u) => { if (!('error' in u)) projectD = u.snapshot })
    const wtD = () => projectD?.repositories[0]?.worktrees.find((w) => w.isMain)
    const row = () => wtD()?.sessions.find((s) => s.id === started.sessionId)
    must(await waitFor(() => !!row()), 'the session is still listed after the restart', JSON.stringify(projectD))
    check(row().agentSessionId === agentSessionId && row().ptyId === undefined, `it kept its agent session id and has no pty (status ${row().status}, loaded ${wtD().loaded})`, JSON.stringify(row()))
    await connD.request('worktree.load', { projectId, worktreeId: wtD().id })
    must(await waitFor(() => !!row()?.ptyId), 'worktree.load gives it a pty', JSON.stringify(row()))
    let resumed = ''
    await new PtyStream(connD).attach(row().ptyId, { onData: (x) => { resumed += x }, onExit: () => {}, onReset: () => {}, onError: () => {} })
    check(await waitFor(() => resumed.includes(`--resume ${agentSessionId}`)), 'the agent is resumed with --resume and its session id', JSON.stringify(resumed))

    for (const x of conns.splice(0)) x.close()
    d.child.kill('SIGTERM')
    await d.exited
    check(d.code === 0 && !existsSync(infoPath) && !existsSync(lockPath), 'SIGTERM again: exit 0, local.json and local.lock gone')

    // --- 10. SIGHUP (the terminal that ran it closed) cleans up too ---
    const h = start()
    must(await waitFor(() => info()?.pid === h.child.pid || h.code !== undefined), 'a start for SIGHUP writes local.json', `code ${h.code}, ${h.err}`)
    h.child.kill('SIGHUP')
    await h.exited
    check(h.code === 0 && !existsSync(infoPath) && !existsSync(lockPath), 'SIGHUP: exit 0, local.json and local.lock gone', `${h.code} ${existsSync(infoPath)} ${existsSync(lockPath)}`)

    // --- 11. a lock path that cannot be taken is a clear error, not a stack trace ---
    mkdirSync(lockPath)
    const e = start()
    await e.exited
    check(e.code === 1 && e.err.includes(`Cannot take the lock ${lockPath}: `) && !e.err.includes('    at '), 'a directory at local.lock: exit 1, "Cannot take the lock"', `${e.code} ${e.err}`)
    rmSync(lockPath, { recursive: true })

    // --- 12. a named profile (a dev build's) runs beside the default one, with its own files ---
    const badName = spawnSync(rt.cmd, [cli, 'start', '--local', '--local-profile', '../x'], { env, encoding: 'utf8' })
    const noLocal = spawnSync(rt.cmd, [cli, 'start', '--local-profile', 'dev'], { env, encoding: 'utf8' })
    check(
      badName.status === 2 && badName.stderr.includes('Invalid local profile name') && noLocal.status === 2 && noLocal.stderr.includes('--local-profile only applies with --local'),
      '--local-profile ../x, and --local-profile without --local, are usage errors (exit 2)',
      `${badName.status} ${noLocal.status} ${noLocal.stderr.slice(0, 200)}`
    )
    const devProfile = join(home, '.config', 'trek-server', 'local-dev')
    const devInfo = join(devProfile, 'local.json')
    const devLock = join(devProfile, 'local.lock')
    const p = start()
    const n = start(['--local-profile', 'dev'])
    must(
      await waitFor(() => (info()?.pid === p.child.pid && info(devInfo)?.pid === n.child.pid) || p.code !== undefined || n.code !== undefined),
      'the default and the dev profile both start: each local.json names its own server',
      `codes ${p.code} ${n.code}, ${p.err} ${n.err}`
    )
    check(lockPid() === p.child.pid && lockPid(devLock) === n.child.pid, 'each profile has its own local.lock, holding its own pid')
    const infoP = info()
    const infoN = info(devInfo)
    check(infoP.port !== infoN.port && infoP.token !== infoN.token, 'they listen on different ports, with different tokens')
    const connP = await connect(infoP.port, infoP.token, 'p')
    const connN = await connect(infoN.port, infoN.token, 'dev')
    check(
      connP.status === 'connected' && connN.status === 'connected' && connN.welcome.capabilities.includes('local') && connP.welcome.serverId !== connN.welcome.serverId,
      'both are welcomed as local servers, with different serverIds (separate configs)',
      `${connP.status} ${connN.status} ${connP.welcome?.serverId} ${connN.welcome?.serverId}`
    )
    for (const x of conns.splice(0)) x.close()
    const stopDev = await runCli(['stop', '--local', '--local-profile', 'dev'])
    await Promise.race([n.exited, new Promise((r) => setTimeout(r, 5000))])
    check(
      stopDev.code === 0 && n.code === 0 && !existsSync(devInfo) && !existsSync(devLock) && p.code === undefined && info()?.pid === p.child.pid && lockPid() === p.child.pid,
      "stop --local --local-profile dev stops only the dev server; the default one's files stay",
      `${stopDev.code} ${n.code} ${p.code} ${stopDev.out} ${stopDev.err}`
    )
    const stopDefault = await runCli(['stop', '--local'])
    await Promise.race([p.exited, new Promise((r) => setTimeout(r, 5000))])
    check(stopDefault.code === 0 && p.code === 0 && !existsSync(infoPath) && !existsSync(lockPath), 'stop --local then stops the default one', `${stopDefault.code} ${p.code}`)
  } catch (err) {
    if (!(err instanceof Abort)) fail(`${rt.name}: ${err.stack ?? err}`)
    for (const r of children) if (r.err) console.error(`[${rt.name} pid ${r.child.pid} stderr]\n${r.err}`)
  } finally {
    await stopAll()
    rmSync(work, { recursive: true, force: true })
  }
}

for (const rt of runtimes) await suite(rt)
console.log(failed ? `LOCAL SMOKE FAIL (${checks} checks)` : `LOCAL SMOKE PASS (${checks} checks)`)
process.exit(failed ? 1 : 0)
