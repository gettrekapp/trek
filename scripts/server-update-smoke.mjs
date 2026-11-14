// scripts/server-update-smoke.mjs — `trek-server update`, end to end, on this machine only: a
// signed release feed served from 127.0.0.1, test builds of the server at two versions (they take
// their feed and key from the environment; a release build never does), the real launcher and
// real running servers, each with its own install folder, config and data in one temp folder.
// macOS and Linux.
//
//   node scripts/server-update-smoke.mjs
//
// Checks: a server that is not a tarball install has no control socket and cannot update;
// --check sees the newer release; with no server running the command only swaps the folder, and
// the next start settles it; a running server is updated by the command and comes back as the new
// version on the same port (with the same pid, where Node can replace a process); a signal during
// that restart wins; a running server's own look at the feed; another install's update, and a
// second server, do not get a config's control socket; SIGTERM removes it; a bad signature, a
// tampered tarball and a version that fails its selfcheck are refused with the server untouched;
// a version that dies at start is rolled back by the next launch; a usage error, a port in use, a
// missing token and a second start at the same moment are not failed starts, and roll nothing back.
import './smokeGh.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POSIX_LAUNCHER } from './serverLaunchers.mjs'

if (process.platform === 'win32') {
  console.log('SERVER UPDATE SMOKE SKIPPED: trek-server does not update itself on Windows')
  process.exit(0)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const TARGET = `${process.platform}-${process.arch}`
const OLD = '9.0.0'
const NEW = '9.0.1'
const WAIT_MS = 20000
/** Whether this Node can replace a running process (22.15 and later): the servers run with this same Node (TREK_NODE below). */
const canExecve = typeof process.execve === 'function'

let failed = 0
let count = 0
const check = (what, ok, detail = '') => {
  count++
  console.log(`${ok ? 'ok' : 'FAIL'}: ${what}${ok || !detail ? '' : `\n  ${String(detail).trimEnd().split('\n').join('\n  ')}`}`)
  if (!ok) failed++
}

// realpath: macOS's /var is a link to /private/var, and the server reports real paths.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-upd-')))
const children = new Set()
let http
const cleanup = () => {
  for (const child of children) child.kill('SIGKILL')
  http?.close()
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130))

/** Resolves true once `pred()` holds, false after `ms`. */
const waitFor = async (pred, ms = WAIT_MS) => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
  return pred()
}

// ---- the builds: one bundle per version, each a test build -------------------------------
function buildServer(version) {
  const out = join(work, 'build', version)
  execFileSync(process.execPath, [join(root, 'server', 'scripts', 'build.mjs'), '--out', out], {
    env: { ...process.env, TREK_SERVER_TEST_UPDATE: '1', TREK_SERVER_TEST_VERSION: version },
    // esbuild's summary goes to stderr: shown only if the build fails (execFileSync's error carries it).
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8'
  })
  return out
}

/**
 * node-pty as a release tarball holds it (scripts/package-server.mjs, prunePty): package.json,
 * lib/ and the one native folder it loads from, with pty.node and (macOS) spawn-helper. Made once
 * from the repo's own, in work/build/node_modules: every install folder gets a copy, and a bundle
 * run straight from work/build/<version> resolves this one.
 */
function prunedPty() {
  const from = join(root, 'node_modules', 'node-pty')
  const to = join(work, 'build', 'node_modules', 'node-pty')
  const native = ['build/Release', `prebuilds/${TARGET}`].find((dir) => existsSync(join(from, dir, 'pty.node')))
  if (!native) throw new Error(`node-pty has no pty.node in build/Release or prebuilds/${TARGET}: run npm ci`)
  mkdirSync(join(to, native), { recursive: true })
  cpSync(join(from, 'package.json'), join(to, 'package.json'))
  cpSync(join(from, 'lib'), join(to, 'lib'), { recursive: true, filter: (src) => !src.endsWith('.test.js') })
  for (const file of ['pty.node', 'spawn-helper']) {
    if (existsSync(join(from, native, file))) cpSync(join(from, native, file), join(to, native, file))
  }
  return to
}

/** A folder laid out as a release tarball's (scripts/package-server.mjs): launcher, bundle, build.json, node-pty. `bundle`: a build's folder, or a script's text. */
function installFolder(at, version, bundle) {
  mkdirSync(join(at, 'bin'), { recursive: true })
  writeFileSync(join(at, 'bin', 'trek-server'), POSIX_LAUNCHER, { mode: 0o755 })
  if (typeof bundle === 'string') writeFileSync(join(at, 'trek-server.cjs'), bundle, { mode: 0o755 })
  else cpSync(join(bundle.dir, 'trek-server.cjs'), join(at, 'trek-server.cjs'))
  const built = typeof bundle === 'string' ? { build: 'smoke' } : JSON.parse(readFileSync(join(bundle.dir, 'build.json'), 'utf8'))
  writeFileSync(join(at, 'build.json'), JSON.stringify({ version, build: built.build, package: 'tarball', target: TARGET }) + '\n')
  cpSync(pty, join(at, 'node_modules', 'node-pty'), { recursive: true })
  return at
}

// ---- the feed: a signed release, served from loopback ------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBKEY = publicKey.export({ type: 'spki', format: 'pem' })
const SUMS = '/releases/latest/download/SHA256SUMS'
/** What the feed serves now: path → bytes. Each scenario sets it. */
let served = new Map()

/** Publishes a release of NEW whose tarball holds `bundle`. `tamper` changes what is served after it is signed. */
function publish(name, bundle, tamper) {
  const folder = `trek-server-${NEW}-${TARGET}`
  const stage = join(work, 'release', name)
  installFolder(join(stage, folder), NEW, bundle)
  const tarball = join(stage, `${folder}.tar.gz`)
  // COPYFILE_DISABLE: macOS's tar would add ._ AppleDouble files for extended attributes.
  execFileSync('tar', ['-czf', tarball, '-C', stage, folder], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = readFileSync(tarball)
  const sums = Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${folder}.tar.gz\n`)
  const tarballPath = `/releases/download/v${NEW}/${folder}.tar.gz`
  const files = new Map([
    [SUMS, sums],
    [`${SUMS}.sig`, Buffer.from(sign(null, sums, privateKey).toString('base64') + '\n')],
    [tarballPath, bytes]
  ])
  tamper?.(files, tarballPath)
  served = files
}

http = createHttpServer((req, res) => {
  const body = served.get(req.url ?? '')
  if (!body) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-length': body.length }).end(body)
})
await new Promise((done) => http.listen(0, '127.0.0.1', done))
const FEED = `http://127.0.0.1:${http.address().port}/releases`

// ---- one install, its config, and how it is run ------------------------------------------
const home = join(work, 'home')
mkdirSync(home, { recursive: true })
// TREK_NODE: the launcher runs this Node, whichever `node` is on PATH.
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TREK_UPDATE_FEED: FEED, TREK_UPDATE_PUBKEY: PUBKEY, TREK_NODE: process.execPath }

const freePort = () =>
  new Promise((done, reject) => {
    const probe = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

/** Runs `file` to its end (the feed is served by this process, so nothing here may block it). */
function runToEnd(file, args, ms = 120000) {
  return new Promise((done) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      children.delete(child)
      done({ status, signal, stderr: err, out: `${out}${err}${signal ? `\n(ended by ${signal})` : ''}` })
    })
  })
}

/**
 * A fresh install of OLD in its own folder, with its own config. The names are short: the control
 * socket sits beside the config, and a Unix socket's path holds about 100 bytes.
 */
async function world(name, { check = false } = {}) {
  const base = join(work, name)
  const install = installFolder(join(base, 'opt', 'trek-server'), OLD, oldBuild)
  const configPath = join(base, 'c', 'config.json')
  mkdirSync(join(base, 'c'), { recursive: true })
  const tokenHash = createHash('sha256').update(randomBytes(16).toString('base64url'), 'utf8').digest('hex')
  writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [], updates: { check } }), { mode: 0o600 })
  const port = await freePort()
  const launcher = join(install, 'bin', 'trek-server')
  const startArgs = ['start', '--config', configPath, '--host', '127.0.0.1', '--port', String(port), '--data-dir', join(base, 'data')]
  const cli = (args) => runToEnd(launcher, [...args, '--config', configPath])
  const versionAt = (dir) => JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')).version
  const state = () => {
    try {
      return JSON.parse(readFileSync(join(base, 'c', 'update-state.json'), 'utf8'))
    } catch {
      return {}
    }
  }
  const marks = () => ['update-pending.json', 'update-pending.tried', 'update-rolled-back.json'].filter((file) => existsSync(join(install, file)))
  return { base, install, configPath, socket: join(base, 'c', 'control.sock'), port, launcher, startArgs, cli, versionAt, state, marks }
}

/** Starts a server. `output` grows; `exited` settles when it ends. */
function start(file, args, extraEnv = {}) {
  const child = spawn(file, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  const run = { child, output: '', ended: null }
  child.stdout.on('data', (d) => { run.output += d })
  child.stderr.on('data', (d) => { run.output += d })
  run.exited = new Promise((done) => child.on('exit', (code, signal) => {
    children.delete(child)
    run.ended = { code, signal }
    done(run.ended)
  }))
  return run
}

/** Waits until `run.output` matches, the process ends, or the time is up. */
const until = async (run, pattern, ms = WAIT_MS) => {
  await waitFor(() => pattern.test(run.output) || run.ended !== null, ms)
  // Its last output can arrive just after its exit.
  if (run.ended !== null) await waitFor(() => pattern.test(run.output), 500)
  return pattern.test(run.output)
}

/** How it ended ({ code, signal }), or null if it has not within `ms`. */
const ending = (run, ms = WAIT_MS) => Promise.race([run.exited, new Promise((done) => setTimeout(() => done(null), ms))])

async function stop(run) {
  if (run.ended === null) run.child.kill('SIGTERM')
  return ending(run, 10000)
}

/** One request on a server's control socket; `onAnswer` runs the moment the answer is read. null when nothing answers. */
function control(socketPath, op, onAnswer) {
  return new Promise((done) => {
    let data = ''
    const socket = createConnection(socketPath)
    const finish = (value) => {
      clearTimeout(timer)
      socket.destroy()
      done(value)
    }
    const timer = setTimeout(() => finish(null), 5000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ op }) + '\n'))
    socket.on('data', (chunk) => {
      data += chunk
      const end = data.indexOf('\n')
      if (end < 0) return
      let answer = null
      try {
        answer = JSON.parse(data.slice(0, end))
      } catch {
        // Not an answer.
      }
      onAnswer?.(answer)
      finish(answer)
    })
    socket.on('error', () => finish(null))
  })
}

const escaped = (text) => text.replaceAll('.', '\\.')
const listeningAs = (version) => new RegExp(`trek-server ${escaped(version)} \\(build [^)]+\\) .* listening on ws://127\\.0\\.0\\.1:`)
const listenings = (run, port) => run.output.split('\n').filter((line) => line.includes(`listening on ws://127.0.0.1:${port}`)).length
/** The server is listening as `version`, and `trek-server update` can reach it. */
const up = async (w, run, version) => (await until(run, listeningAs(version))) && (await waitFor(() => existsSync(w.socket)))

// ---- the bundles -------------------------------------------------------------------------
console.log('building two test builds of trek-server…')
const oldBuild = { dir: buildServer(OLD) }
const newBuild = { dir: buildServer(NEW) }
const pty = prunedPty()
check('the builds are marked as test builds', JSON.parse(readFileSync(join(oldBuild.dir, 'build.json'), 'utf8')).testUpdate === true)
{
  const longest = join(work, 'xxxx', 'c', 'control.sock')
  check('the control sockets fit a Unix socket path here', Buffer.byteLength(longest) <= 103, `${longest} is ${Buffer.byteLength(longest)} bytes (the temp folder is too deep)`)
}

/** A version that passes nothing: its selfcheck fails. */
const FAILS_SELFCHECK = `#!/usr/bin/env node\nif (process.argv[2] === 'version') { console.log('${NEW}'); process.exit(0) }\nconsole.error('FAIL: node-pty loads\\n  simulated: this version cannot run here')\nprocess.exit(1)\n`
/** A version whose selfcheck passes and whose start dies before listening. */
const DIES_AT_START = `#!/usr/bin/env node\nconst cmd = process.argv[2]\nif (cmd === 'version') { console.log('${NEW}'); process.exit(0) }\nif (cmd === 'selfcheck') { console.log('ok: simulated'); process.exit(0) }\nconsole.error('simulated: this version dies at start')\nprocess.exit(1)\n`

// ---- 1. a server that is not a tarball install: nothing changes for it --------------------
{
  const base = join(work, 'plain')
  mkdirSync(join(base, 'c'), { recursive: true })
  const configPath = join(base, 'c', 'config.json')
  const tokenHash = createHash('sha256').update(randomBytes(16).toString('base64url'), 'utf8').digest('hex')
  // updates.check is left at its default (on): what stops it here is that this is not an install.
  writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [] }), { mode: 0o600 })
  publish('good', newBuild)
  const bundle = join(oldBuild.dir, 'trek-server.cjs')
  const run = start(process.execPath, [bundle, 'start', '--config', configPath, '--host', '127.0.0.1', '--port', String(await freePort()), '--data-dir', join(base, 'data')], { TREK_UPDATE_FIRST_CHECK_MS: '1000' })
  check('a bundle that is not a tarball install starts', await until(run, listeningAs(OLD)), run.output)
  const refused = await runToEnd(process.execPath, [bundle, 'update', '--check', '--config', configPath])
  check('its update command says it cannot update itself', refused.status === 1 && /cannot update itself here: .*not installed from a release tarball/.test(refused.stderr), refused.out)
  check('it has no control socket, and says nothing about updates', !existsSync(join(base, 'c', 'control.sock')) && !existsSync(join(base, 'c', 'update-state.json')) && !/update:/.test(run.output), run.output)
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 2. --check; then, with no server running, the command only swaps the folder ----------
{
  const w = await world('check')
  publish('good', newBuild)
  const checked = await w.cli(['update', '--check'])
  check(`update --check reports ${NEW}`, checked.status === 0 && checked.out.includes(`trek-server ${OLD}; ${NEW} is available`), checked.out)
  check('--check installs nothing', w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`))
  check('the check is remembered', w.state().latest === NEW && typeof w.state().lastCheckAt === 'string', JSON.stringify(w.state()))
  const unasked = await w.cli(['update'])
  check('without --yes and without a terminal, it does not install', unasked.status === 1 && /update --yes/.test(unasked.stderr) && w.versionAt(w.install) === OLD, unasked.out)

  const updated = await w.cli(['update', '--yes'])
  check('with no server running, update --yes installs', updated.status === 0 && updated.out.includes(`Updated to trek-server ${NEW}`), updated.out)
  check('the install path holds the new version, the old one is kept', w.versionAt(w.install) === NEW && w.versionAt(`${w.install}.previous`) === OLD)
  check('it is marked as not started yet', w.marks().join() === 'update-pending.json', w.marks().join())
  check('nothing is left beside the install', !existsSync(join(w.base, 'opt', '.trek-update.lock')) && !existsSync(join(w.base, 'opt', `.trek-update-${NEW}`)) && !existsSync(join(w.base, 'opt', `.trek-update-${NEW}.tar.gz`)))
  const again = await w.cli(['update', '--yes'])
  check('a second update finds nothing newer', again.status === 0 && again.out.includes(`trek-server ${NEW} is the latest version`), again.out)
  const run = start(w.launcher, w.startArgs)
  check(`the next start is ${NEW}, and settles the update`, (await up(w, run, NEW)) && (await until(run, new RegExp(`update: now running trek-server ${escaped(NEW)} \\(was ${escaped(OLD)}\\)`))), run.output)
  check('the markers are gone and the result is recorded', w.marks().length === 0 && w.state().lastResult?.ok === true && w.state().lastResult?.to === NEW, `${w.marks().join()} ${JSON.stringify(w.state())}`)

  // A signal while the server restarts for an update: it exits instead (a service manager stopping the unit wins).
  if (canExecve) {
    const answer = await control(w.socket, 'relaunch', (a) => {
      if (a?.ok === true) run.child.kill('SIGTERM')
    })
    check('the server accepts a relaunch request', answer?.ok === true, JSON.stringify(answer))
    const ended = await ending(run)
    check('SIGTERM during the restart ends the server instead', ended?.code === 0 && /update: SIGTERM during the restart; exiting instead/.test(run.output) && listenings(run, w.port) === 1, `${JSON.stringify(ended)}\n${run.output}`)
    check('and its control socket is gone', !existsSync(w.socket))
  } else {
    const answer = await control(w.socket, 'relaunch')
    check('this Node cannot replace a process: a relaunch request is refused', answer?.ok === false && /cannot replace a running process/.test(answer.error ?? ''), JSON.stringify(answer))
    await stop(run)
  }
}

// ---- 3. a running server is updated by the command ---------------------------------------
{
  const w = await world('live')
  publish('good', newBuild)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const pid = run.child.pid
  const status = await control(w.socket, 'status')
  check('its control socket says what is running', status?.pid === pid && status?.version === OLD && status?.installDir === w.install && status?.sessions === 0 && status?.canRelaunch === canExecve, JSON.stringify(status))

  const updated = await w.cli(['update', '--yes'])
  check('update --yes installs while the server runs', updated.status === 0 && updated.out.includes(`Installed trek-server ${NEW}`), updated.out)
  if (canExecve) {
    check('the command says the server is restarting', updated.out.includes(`the running server (pid ${pid}) is restarting into it`), updated.out)
    check(`the same process comes back as ${NEW}`, await up(w, run, NEW), run.output)
    check('on the same port', listenings(run, w.port) === 2, run.output)
    check('with the same pid', run.ended === null && (await control(w.socket, 'status'))?.pid === pid)
    check('the shutdown named the update', /update — shutting down/.test(run.output), run.output)
    check('the update is settled', (await until(run, new RegExp(`update: now running trek-server ${escaped(NEW)} \\(was ${escaped(OLD)}\\)`))) && w.state().lastResult?.ok === true && w.marks().length === 0, `${w.marks().join()} ${JSON.stringify(w.state())}`)
    check('the old version is kept beside it', w.versionAt(`${w.install}.previous`) === OLD)
    const latest = await w.cli(['update', '--check'])
    check('and it is now the latest version', latest.status === 0 && latest.out.includes(`trek-server ${NEW} is the latest version`), latest.out)
    const ended = await stop(run)
    check('SIGTERM stops the restarted server', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
  } else {
    check('this Node cannot replace a process: the command says a restart finishes it', new RegExp(`Restart the running server \\(pid ${pid}\\) to finish`).test(updated.out), updated.out)
    check(`${OLD} is still running, with the update not started yet`, run.ended === null && listenings(run, w.port) === 1 && w.marks().join() === 'update-pending.json', run.output)
    const ended = await stop(run)
    check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
    const next = start(w.launcher, w.startArgs)
    check(`the next start is ${NEW}, and settles the update`, (await up(w, next, NEW)) && (await until(next, new RegExp(`update: now running trek-server ${escaped(NEW)} \\(was ${escaped(OLD)}\\)`))) && w.marks().length === 0, next.output)
    await stop(next)
  }
}

// ---- 4. one config, one control socket: the daily check, another install, a second server --
{
  const w = await world('own', { check: true })
  publish('good', newBuild)
  // A test build's knob: the first look at the feed a second after listening, not thirty.
  const run = start(w.launcher, w.startArgs, { TREK_UPDATE_FIRST_CHECK_MS: '1000' })
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  check('the running server finds the newer release by itself', (await until(run, new RegExp(`update: trek-server ${escaped(NEW)} is available \\(this is ${escaped(OLD)}\\)`))) && w.state().latest === NEW, `${run.output}\n${JSON.stringify(w.state())}`)

  // Another install folder, pointed at the same config.
  const other = installFolder(join(w.base, 'opt2', 'trek-server'), OLD, oldBuild)
  const refused = await runToEnd(join(other, 'bin', 'trek-server'), ['update', '--yes', '--config', w.configPath])
  check('another install does not update under a running server', refused.status === 1 && refused.stderr.includes(`(pid ${run.child.pid}) is another install, ${w.install}`), refused.out)
  check('and neither install changed', w.versionAt(w.install) === OLD && w.versionAt(other) === OLD && !existsSync(`${other}.previous`) && !existsSync(`${w.install}.previous`) && !/shutting down/.test(run.output), run.output)

  // A second server with the same config: the first keeps the socket.
  const second = start(w.launcher, ['start', '--config', w.configPath, '--host', '127.0.0.1', '--port', String(await freePort()), '--data-dir', join(w.base, 'data2')])
  check('a second server with the same config runs without the control socket', (await until(second, listeningAs(OLD))) && (await until(second, /update: no control socket at .*another trek-server is running with this config and has it/)), second.output)
  const secondEnded = await stop(second)
  check('stopping it leaves the first one\'s socket alone', secondEnded?.code === 0 && (await control(w.socket, 'status'))?.pid === run.child.pid, `${JSON.stringify(secondEnded)}\n${second.output}`)

  const ended = await stop(run)
  check('SIGTERM stops the server and removes its control socket', ended?.code === 0 && !existsSync(w.socket) && !existsSync(`${w.socket}.lock`), `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 5. a release that is not what was signed --------------------------------------------
for (const [name, what, tamper, message] of [
  ['sig', 'a SHA256SUMS signed by another key', (files) => files.set(`${SUMS}.sig`, Buffer.from(sign(null, files.get(SUMS), generateKeyPairSync('ed25519').privateKey).toString('base64'))), /no valid signature/],
  ['tar', 'a tarball changed after it was signed', (files, path) => files.set(path, Buffer.concat([files.get(path), Buffer.from('x')])), /the download's sha256 is/]
]) {
  const w = await world(name)
  publish(name, newBuild, tamper)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const updated = await w.cli(['update', '--yes'])
  check(`${what} is refused`, updated.status === 1 && message.test(updated.out), updated.out)
  check('and the running server is untouched', run.ended === null && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0 && !/shutting down/.test(run.output), run.output)
  await stop(run)
}

// ---- 6. a version that fails its selfcheck -----------------------------------------------
{
  const w = await world('self')
  publish('fails-selfcheck', FAILS_SELFCHECK)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const updated = await w.cli(['update', '--yes'])
  check('a version that fails its selfcheck is refused before the swap', updated.status === 1 && /does not run on this machine/.test(updated.out) && /simulated: this version cannot run here/.test(updated.out), updated.out)
  check('the running server and its install are untouched', run.ended === null && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0 && !/shutting down/.test(run.output), run.output)
  check('the failure is recorded', w.state().lastResult?.ok === false && w.state().lastResult?.to === NEW, JSON.stringify(w.state()))
  check('nothing is left beside the install', !existsSync(join(w.base, 'opt', '.trek-update.lock')) && !existsSync(join(w.base, 'opt', `.trek-update-${NEW}`)) && !existsSync(join(w.base, 'opt', `.trek-update-${NEW}.tar.gz`)))
  await stop(run)
}

// ---- 7. a version that dies at start is rolled back by the next launch -------------------
{
  const w = await world('dies')
  publish('dies-at-start', DIES_AT_START)
  const updated = await w.cli(['update', '--yes'])
  check('a version whose selfcheck passes installs', updated.status === 0 && w.versionAt(w.install) === NEW, updated.out)
  // The first launch (a service manager, or the user): the new version dies.
  const first = start(w.launcher, w.startArgs)
  const firstEnded = await ending(first)
  check('the new version dies at its first start', firstEnded?.code === 1 && (await until(first, /dies at start/)), `${JSON.stringify(firstEnded)}\n${first.output}`)
  check('that start was marked tried', w.marks().join() === 'update-pending.json,update-pending.tried', w.marks().join())
  // The next launch: the launcher puts the old version back.
  const second = start(w.launcher, w.startArgs)
  check(`the next launch goes back to ${OLD}`, (await up(w, second, OLD)) && /going back to the version before it/.test(second.output), second.output)
  check('the install path holds the old version again; the failed one is set aside', w.versionAt(w.install) === OLD && w.versionAt(`${w.install}.failed`) === NEW && !existsSync(`${w.install}.previous`))
  check('the restored server reports the failed update', await until(second, new RegExp(`update: trek-server ${escaped(NEW)} did not start; went back to ${escaped(OLD)}`)), second.output)
  check('and records it', w.state().lastResult?.ok === false && /did not start/.test(w.state().lastResult?.error ?? '') && w.marks().length === 0, `${w.marks().join()} ${JSON.stringify(w.state())}`)
  const ended = await stop(second)
  check('SIGTERM stops the restored server', ended?.code === 0, `${JSON.stringify(ended)}\n${second.output}`)
}

// ---- 8. starts that end before listening, or at the same moment, are not failed starts -----
{
  const w = await world('ends')
  publish('good', newBuild)
  const updated = await w.cli(['update', '--yes'])
  check('an update with no server running installs', updated.status === 0 && w.versionAt(w.install) === NEW, updated.out)
  const pendingOnly = () => w.marks().join() === 'update-pending.json'
  const notRolledBack = () => w.versionAt(w.install) === NEW && w.versionAt(`${w.install}.previous`) === OLD && !existsSync(`${w.install}.failed`)

  // The launcher takes these for a start (it does not know every flag); the server refuses them.
  for (const args of [['--prot', '7000'], [`--port=${w.port}`], ['start', 'help']]) {
    const refused = await runToEnd(w.launcher, args)
    check(`\`trek-server ${args.join(' ')}\` is a usage error, and leaves the update untried`, refused.status === 2 && /Usage: trek-server/.test(refused.stderr) && pendingOnly() && notRolledBack(), `${refused.status} ${w.marks().join()}\n${refused.out}`)
  }

  // Something else has the port.
  const squatter = createNetServer()
  await new Promise((done) => squatter.listen(w.port, '127.0.0.1', done))
  const busy = await runToEnd(w.launcher, w.startArgs)
  check('a start whose port is in use fails, and leaves the update untried', busy.status === 1 && /already in use/.test(busy.stderr) && pendingOnly() && notRolledBack(), `${busy.status} ${w.marks().join()}\n${busy.out}`)
  await new Promise((done) => squatter.close(done))

  // No token configured.
  const bare = join(w.base, 'c', 'bare.json')
  writeFileSync(bare, JSON.stringify({ repos: [] }), { mode: 0o600 })
  const tokenless = await runToEnd(w.launcher, ['start', '--config', bare, '--host', '127.0.0.1', '--port', String(w.port), '--data-dir', join(w.base, 'data')])
  check('a start with no token configured fails, and leaves the update untried', tokenless.status === 1 && /No token configured/.test(tokenless.stderr) && pendingOnly() && notRolledBack(), `${tokenless.status} ${w.marks().join()}\n${tokenless.out}`)

  // Two starts of one install at the same moment (two units, or a start by hand beside a service
  // manager's): the second comes while the first is marked tried and not listening yet.
  const first = start(w.launcher, w.startArgs)
  const marked = await waitFor(() => existsSync(join(w.install, 'update-pending.tried')) || first.ended !== null)
  const second = start(w.launcher, ['start', '--config', w.configPath, '--host', '127.0.0.1', '--port', String(await freePort()), '--data-dir', join(w.base, 'data2')])
  check('the first start is marked tried while it starts', marked && first.ended === null, first.output)
  check(`both starts come up as ${NEW}`, (await until(first, listeningAs(NEW))) && (await until(second, listeningAs(NEW))), `${first.output}\n---\n${second.output}`)
  check('neither moved the install from under the other', notRolledBack() && !/going back/.test(first.output + second.output), `${first.output}\n---\n${second.output}`)
  check('and the update is settled', (await waitFor(() => w.marks().length === 0)) && w.state().lastResult?.ok === true && w.state().lastResult?.to === NEW, `${w.marks().join()} ${JSON.stringify(w.state())}`)
  const ends = [await stop(second), await stop(first)]
  check('SIGTERM stops both', ends.every((e) => e?.code === 0), JSON.stringify(ends))
}

cleanup()
process.removeListener('exit', cleanup)
if (failed > 0) {
  console.log(`SERVER UPDATE SMOKE FAIL (${failed} of ${count} checks failed)`)
  process.exit(1)
}
console.log(`SERVER UPDATE SMOKE PASS (${count} checks)`)
process.exit(0)
